-- 013_analytics_campaigns.sql — the Campaigns table.
--
-- Split into a PARENT rpc (one row per campaign) and a CHILDREN rpc (steps for
-- one campaign), deliberately:
--   * the parent query stays ~95 rows regardless of how much is expanded;
--   * expanding a campaign is a 40ms request, not a re-run of the whole grid.
-- Returning the whole tree up front would mean computing step stats for 95
-- campaigns to render maybe two expanded ones.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_campaign_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   BIGINT,
  campaign_name TEXT,
  status        TEXT,
  client_name   TEXT,
  step_count    BIGINT,
  sent          BIGINT,
  prospects     BIGINT,
  replies       BIGINT,
  human_replies BIGINT,
  positive      BIGINT,
  negative      BIGINT,
  neutral       BIGINT,
  bot_replies   BIGINT,
  bounces       BIGINT,
  median_reply_seconds NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT c.id, c.name, c.status, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  series AS (
    SELECT s.campaign_id,
           SUM(s.value) FILTER (WHERE s.metric = 'sent')    AS sent,
           SUM(s.value) FILTER (WHERE s.metric = 'bounces') AS bounces
    FROM eb_daily_series s
    WHERE s.team_id = p_team_id AND s.campaign_id <> 0
      AND s.stat_date BETWEEN p_from AND p_to
    GROUP BY s.campaign_id
  ),
  day_stats AS (
    SELECT d.campaign_id, SUM(d.total_leads_contacted) AS prospects
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
    GROUP BY d.campaign_id
  ),
  reply_stats AS (
    SELECT r.campaign_id,
           COUNT(*)                                      AS replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply)  AS human,
           COUNT(*) FILTER (WHERE r.automated_reply)      AS bot,
           COUNT(*) FILTER (WHERE r.interested)           AS positive,
           -- Sentiment: EmailBison's `interested` gives a positive signal only.
           -- There is no negative signal upstream, so `negative` is honestly 0
           -- and everything not-positive is neutral. The column exists so the
           -- group is a real code path rather than a stub, and so a classifier
           -- can populate it later without a schema change.
           COUNT(*) FILTER (WHERE r.sentiment = 'negative') AS negative,
           COUNT(*) FILTER (WHERE NOT r.interested
                              AND (r.sentiment IS NULL OR r.sentiment = 'neutral')) AS neutral,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
           ) FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at) AS median_reply
    FROM replies r
    WHERE r.team_id = p_team_id AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
    GROUP BY r.campaign_id
  )
  SELECT
    sc.id, sc.name, sc.status, cl.name,
    (SELECT COUNT(*) FROM sequence_steps st WHERE st.campaign_id = sc.id)::BIGINT,
    COALESCE(se.sent, 0)::BIGINT,
    COALESCE(ds.prospects, 0)::BIGINT,
    COALESCE(rs.replies, 0)::BIGINT,
    COALESCE(rs.human, 0)::BIGINT,
    COALESCE(rs.positive, 0)::BIGINT,
    COALESCE(rs.negative, 0)::BIGINT,
    COALESCE(rs.neutral, 0)::BIGINT,
    COALESCE(rs.bot, 0)::BIGINT,
    COALESCE(se.bounces, 0)::BIGINT,
    rs.median_reply
  FROM scoped sc
  LEFT JOIN clients cl    ON cl.id = sc.client_id
  LEFT JOIN series se     ON se.campaign_id = sc.id
  LEFT JOIN day_stats ds  ON ds.campaign_id = sc.id
  LEFT JOIN reply_stats rs ON rs.campaign_id = sc.id
  -- Campaigns with nothing in the window are dropped rather than listed as
  -- zero rows: 95 campaigns of which most are dormant would bury the ~20 live
  -- ones under noise.
  WHERE COALESCE(se.sent, 0) > 0 OR COALESCE(rs.replies, 0) > 0
  ORDER BY COALESCE(se.sent, 0) DESC;
$$;

-- Step rows for ONE campaign. Called lazily, on first expand.
CREATE OR REPLACE FUNCTION analytics_campaign_steps(
  p_campaign_id BIGINT,
  p_from        DATE,
  p_to          DATE
)
RETURNS TABLE (
  sequence_step_id BIGINT,
  step_order       INTEGER,
  email_subject    TEXT,
  email_body       TEXT,
  wait_in_days     INTEGER,
  thread_reply     BOOLEAN,
  is_variant       BOOLEAN,
  sent             BIGINT,
  leads_contacted  BIGINT,
  unique_replies   BIGINT,
  bounced          BIGINT,
  unsubscribed     BIGINT,
  interested       BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COALESCE(st.id, ss.sequence_step_id),
    st.step_order,
    COALESCE(st.email_subject, ss.email_subject),
    st.email_body,
    st.wait_in_days,
    COALESCE(st.thread_reply, FALSE),
    COALESCE(st.is_variant, FALSE),
    COALESCE(ss.sent, 0)::BIGINT,
    COALESCE(ss.leads_contacted, 0)::BIGINT,
    COALESCE(ss.unique_replies, 0)::BIGINT,
    COALESCE(ss.bounced, 0)::BIGINT,
    COALESCE(ss.unsubscribed, 0)::BIGINT,
    COALESCE(ss.interested, 0)::BIGINT
  FROM sequence_steps st
  -- FULL JOIN, not LEFT: EmailBison can report stats for a step that has since
  -- been deleted from the sequence, and silently dropping that day's volume
  -- would make the step rows fail to sum to the campaign.
  FULL OUTER JOIN (
    SELECT sequence_step_id, MAX(email_subject) AS email_subject,
           SUM(sent) AS sent, SUM(leads_contacted) AS leads_contacted,
           SUM(unique_replies) AS unique_replies, SUM(bounced) AS bounced,
           SUM(unsubscribed) AS unsubscribed, SUM(interested) AS interested
    FROM campaign_step_stats_daily
    WHERE campaign_id = p_campaign_id AND stat_date BETWEEN p_from AND p_to
    GROUP BY sequence_step_id
  ) ss ON ss.sequence_step_id = st.id
  WHERE st.campaign_id = p_campaign_id OR st.campaign_id IS NULL
  ORDER BY st.step_order NULLS LAST, 1;
$$;

NOTIFY pgrst, 'reload schema';

INSERT INTO schema_migrations (version) VALUES ('013_analytics_campaigns')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
