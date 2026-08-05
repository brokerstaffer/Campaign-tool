-- 043 — a variant is not a step.
--
-- Reported from the product: a campaign with 3 steps and 1 variant on step 3
-- was shown as "4 steps". The count was a plain COUNT(*) over sequence_steps,
-- which includes variants.
--
-- EmailBison's own model is unambiguous about the difference, verified against
-- /api/campaigns/v1.1/{id}/sequence-steps:
--
--   step     order = 1,2,3…   variant = false   variant_from_step_id = null
--   variant  order = NULL     variant = true    variant_from_step_id = <step>
--
-- Only a step carries a position in the sequence. A variant is an alternative
-- WORDING of one step, and a lead receives one email at that position either
-- way — so counting it as a step overstates the length of the sequence, and
-- "3 steps" vs "4 steps" is the difference between a reader trusting this
-- dashboard and checking it against EmailBison every time.
--
-- Confirmed across the workspace: 289 steps all carry an order, and 16 of 17
-- variants have order NULL. The single exception was created by a bug in the
-- copy-sequence renumbering (since fixed) and is corrected here.

BEGIN;

-- Repair the one variant a bad renumber gave a position.
UPDATE sequence_steps SET step_order = NULL
WHERE is_variant AND step_order IS NOT NULL;

DROP FUNCTION IF EXISTS analytics_campaign_rows(BIGINT, DATE, DATE, BIGINT[], UUID[]);

CREATE FUNCTION analytics_campaign_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  campaign_id          BIGINT,
  campaign_name        TEXT,
  status               TEXT,
  client_name          TEXT,
  step_count           BIGINT,
  variant_count        BIGINT,
  sent                 BIGINT,
  prospects            BIGINT,
  replies              BIGINT,
  human_replies        BIGINT,
  positive             BIGINT,
  negative             BIGINT,
  neutral              BIGINT,
  bot_replies          BIGINT,
  bounces              BIGINT,
  median_reply_seconds NUMERIC,
  avg_reply_seconds    NUMERIC,
  bounces_hard         BIGINT,
  bounces_soft         BIGINT,
  introductions        BIGINT,
  phone_screens        BIGINT,
  interviews           BIGINT,
  hires                BIGINT,
  outcomes_total       BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT c.id, c.name, c.status, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
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
      AND s.campaign_id IN (SELECT id FROM scoped)
    GROUP BY s.campaign_id
  ),
  day_stats AS (
    SELECT d.campaign_id, SUM(d.total_leads_contacted) AS prospects
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY d.campaign_id
  ),
  step_counts AS (
    SELECT st.campaign_id,
           COUNT(*) FILTER (WHERE NOT st.is_variant) AS steps,
           COUNT(*) FILTER (WHERE st.is_variant)     AS variants
    FROM sequence_steps st
    WHERE st.team_id = p_team_id
    GROUP BY st.campaign_id
  ),
  reply_stats AS (
    SELECT r.campaign_id,
           COUNT(*)                                            AS replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply)       AS human,
           COUNT(*) FILTER (WHERE r.interested)                AS positive,
           COUNT(*) FILTER (WHERE r.sentiment = 'negative')    AS negative,
           COUNT(*) FILTER (WHERE r.sentiment = 'neutral')     AS neutral,
           COUNT(*) FILTER (WHERE r.automated_reply)           AS bots,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
           ) FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS median_reply,
           AVG(EXTRACT(EPOCH FROM (r.date_received - r.first_send_at)))
             FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS avg_reply
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  bounce_split AS (
    SELECT r.campaign_id,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'hard') AS hard,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'soft') AS soft
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  outcomes AS (
    SELECT o.resolved_campaign_id AS campaign_id,
           COUNT(*) FILTER (WHERE o.event_type = 'introduction') AS introductions,
           COUNT(*) FILTER (WHERE o.event_type IN ('phone_screen','phone_screen_scheduled')) AS phone_screens,
           COUNT(*) FILTER (WHERE o.event_type IN ('interview','interview_scheduled')) AS interviews,
           COUNT(*) FILTER (WHERE o.event_type = 'hired') AS hires,
           COUNT(*) AS total
    FROM outcome_events o
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND o.resolved_campaign_id IN (SELECT id FROM scoped)
    GROUP BY o.resolved_campaign_id
  )
  SELECT
    sc.id, sc.name, sc.status, cl.name,
    COALESCE(stc.steps, 0)::BIGINT,
    COALESCE(stc.variants, 0)::BIGINT,
    COALESCE(se.sent, 0)::BIGINT,
    COALESCE(ds.prospects, 0)::BIGINT,
    COALESCE(rs.replies, 0)::BIGINT,
    COALESCE(rs.human, 0)::BIGINT,
    COALESCE(rs.positive, 0)::BIGINT,
    COALESCE(rs.negative, 0)::BIGINT,
    COALESCE(rs.neutral, 0)::BIGINT,
    COALESCE(rs.bots, 0)::BIGINT,
    COALESCE(se.bounces, 0)::BIGINT,
    rs.median_reply,
    rs.avg_reply,
    COALESCE(bs.hard, 0)::BIGINT,
    COALESCE(bs.soft, 0)::BIGINT,
    COALESCE(oc.introductions, 0)::BIGINT,
    COALESCE(oc.phone_screens, 0)::BIGINT,
    COALESCE(oc.interviews, 0)::BIGINT,
    COALESCE(oc.hires, 0)::BIGINT,
    COALESCE(oc.total, 0)::BIGINT
  FROM scoped sc
  LEFT JOIN clients cl      ON cl.id = sc.client_id
  LEFT JOIN step_counts stc ON stc.campaign_id = sc.id
  LEFT JOIN series se       ON se.campaign_id = sc.id
  LEFT JOIN day_stats ds    ON ds.campaign_id = sc.id
  LEFT JOIN reply_stats rs  ON rs.campaign_id = sc.id
  LEFT JOIN bounce_split bs ON bs.campaign_id = sc.id
  LEFT JOIN outcomes oc     ON oc.campaign_id = sc.id
  ORDER BY COALESCE(se.sent, 0) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('043_step_count_excludes_variants')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
