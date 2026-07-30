-- 009_analytics_kpis.sql — the KPI band, in one call.
--
-- All aggregation happens HERE, never in JS. PostgREST caps result sets at 1000
-- rows and truncates SILENTLY, so a `.select()` + reduce would quietly report
-- wrong totals the moment the data grew past a page.
--
-- Both periods are returned by ONE call when p_compare is true. Two round trips
-- would double the latency of every filter change with the compare toggle on.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_kpis(
  p_team_id     BIGINT,
  p_from        DATE,
  p_to          DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids  UUID[]   DEFAULT NULL,
  p_compare     BOOLEAN  DEFAULT FALSE
)
RETURNS TABLE (
  period          TEXT,
  range_from      DATE,
  range_to        DATE,
  sent            BIGINT,
  prospects       BIGINT,
  replies         BIGINT,
  human_replies   BIGINT,
  positive        BIGINT,
  bounces         BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH periods AS (
    SELECT 'current'::TEXT AS period, p_from AS f, p_to AS t
    UNION ALL
    -- The immediately preceding window of identical length, ending the day
    -- before p_from. Derived here so the SQL and the UI cannot disagree about
    -- which days "previous" means.
    SELECT 'previous',
           p_from - (p_to - p_from + 1),
           p_from - 1
    WHERE p_compare
  ),
  -- Campaigns in scope. Excluded ones (templates, internal lists, tests) are
  -- omitted from every number -- see migration 008. Consequence: totals here
  -- will NOT equal the EmailBison workspace aggregate.
  scoped AS (
    SELECT c.id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  )
  SELECT
    pr.period,
    pr.f,
    pr.t,
    -- Sent and Bounces come from the cached daily series (EmailBison's own
    -- per-day numbers), summed over the in-scope campaigns.
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'sent'
                AND s.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    -- Prospects = DISTINCT leads contacted in the range. NOT a sum of the daily
    -- values: a lead emailed on two days appears in both, so summing
    -- overcounts. This is why the Prospects chart line legitimately does not
    -- add up to this tile.
    COALESCE((SELECT SUM(d.total_leads_contacted) FROM campaign_day_stats d
              WHERE d.team_id = p_team_id
                AND d.campaign_id IN (SELECT id FROM scoped)
                AND d.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    -- Replies / Human / Positive all come from local reply rows, never from the
    -- daily series. Human Replies has no EmailBison equivalent, and three
    -- numbers on one tile row sourced two different ways would not add up.
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.automated_reply
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND r.interested
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'bounces'
                AND s.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT
  FROM periods pr;
$$;

-- Median Reply Time, separated because its population is replies that have had
-- their first-send timestamp resolved -- a different and smaller set than the
-- reply counts above. Returning it from the same function would force every
-- caller to reason about two different denominators.
CREATE OR REPLACE FUNCTION analytics_reply_timing(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (median_reply_seconds NUMERIC, sample_size BIGINT)
LANGUAGE sql
STABLE
AS $$
  SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
    ),
    COUNT(*)
  FROM replies r
  JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id AND NOT cc.excluded
  WHERE r.team_id = p_team_id
    AND r.tracked_reply
    AND r.first_send_at IS NOT NULL
    AND r.date_received > r.first_send_at
    AND r.received_date BETWEEN p_from AND p_to
    AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
    AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids));
$$;

NOTIFY pgrst, 'reload schema';

INSERT INTO schema_migrations (version) VALUES ('009_analytics_kpis')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
