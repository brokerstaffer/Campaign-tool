-- 031 — the Events column group for the Campaigns table (WT §5.3 / §7):
-- "The same event counts also appear as optional columns in the Campaigns
-- table, so you can read outcomes alongside reply rates in one row."
--
-- Cheap now: outcome_events has been populated and attributed since 023-026,
-- so this migration only reads it.
--
-- MEDIAN FOLLOW-UP PER CAMPAIGN IS DELIBERATELY NOT HERE, having been built and
-- then removed once measured. §5.3 lists it, but no source can produce it:
--
--   * replies.first_followup_at is NULL on all 8,033 rows. sync-reply-timing
--     resolves first_send_at and never writes it.
--   * The obvious fix — EmailBison's conversation-thread `newer_messages`, which
--     the original plan specified for exactly this — returns EMPTY. Sampled 12
--     human replies older than 20 days: 0 had any newer message, and 0 had a
--     sent one. The team answers from the portal inbox, not from EmailBison, so
--     the follow-up never appears in EmailBison's thread at all.
--   * The portal DOES have it (that is where the KPI tile gets 19m, business-
--     hours adjusted) but exposes only workspace-level and per-DAY figures.
--     group_by/breakdown/by=campaign are all ignored.
--
-- A column that can only ever render a dash on every row is worse than an
-- absent one: it implies the data exists and is merely missing here. It comes
-- back when the portal can group by campaign — see docs/remaining-work.md.
--
-- WHY THE EVENT COUNTS ARE ATTRIBUTED-ONLY, AND WHY THAT IS THE RIGHT CHOICE:
-- an outcome reaches a campaign through resolved_campaign_id, which is set only
-- when we can prove which campaign earned it. Instantly outcomes and
-- unmatched ones therefore contribute to no campaign row. That means
-- SUM(campaign events) < total events on the Attribution tab, deliberately: the
-- alternative is spreading unattributed outcomes across campaigns that did not
-- earn them, which is the exact error 025 exists to prevent.

BEGIN;

-- Signature kept EXACTLY as it was — p_campaign_ids before p_client_ids, no
-- sort/limit. Adding an overload with a different parameter order made
-- PostgREST unable to choose between them ("function is not unique"), because
-- it resolves by argument NAME and both candidates matched.
DROP FUNCTION IF EXISTS analytics_campaign_rows(BIGINT, DATE, DATE, BIGINT[], UUID[]);
DROP FUNCTION IF EXISTS analytics_campaign_rows(BIGINT, DATE, DATE, UUID[], BIGINT[], TEXT, TEXT, INT, INT);

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
  -- The Events group (WT §5.3 / §7).
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
                       AND r.date_received > r.first_send_at)  AS median_reply
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  outcomes AS (
    /*
     * Counted per campaign, by the funnel stage the Attribution tab uses.
     * `resolved_campaign_id` only, so nothing lands on a campaign that cannot
     * be shown to have earned it.
     */
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
    (SELECT COUNT(*) FROM sequence_steps st WHERE st.campaign_id = sc.id)::BIGINT,
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
    -- COALESCE to 0: a campaign with no outcomes has genuinely earned none.
    -- That is different from a rate, which stays NULL and renders as a dash.
    COALESCE(oc.introductions, 0)::BIGINT,
    COALESCE(oc.phone_screens, 0)::BIGINT,
    COALESCE(oc.interviews, 0)::BIGINT,
    COALESCE(oc.hires, 0)::BIGINT,
    COALESCE(oc.total, 0)::BIGINT
  FROM scoped sc
  LEFT JOIN clients cl     ON cl.id = sc.client_id
  LEFT JOIN series se      ON se.campaign_id = sc.id
  LEFT JOIN day_stats ds   ON ds.campaign_id = sc.id
  LEFT JOIN reply_stats rs ON rs.campaign_id = sc.id
  LEFT JOIN outcomes oc    ON oc.campaign_id = sc.id
  ORDER BY COALESCE(se.sent, 0) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('031_campaign_followup_events')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
