-- 011_analytics_timeseries.sql — the daily series behind the Charts sub-view.
--
-- One row per day per period, with all six series as columns. Wide rather than
-- long because the chart wants exactly this shape and pivoting 6 metrics x 90
-- days in JS is pointless work.
--
-- Days with no activity are still emitted (via generate_series) so the x-axis
-- has no gaps -- a missing day would make the line jump across it as though the
-- two neighbours were adjacent.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_timeseries(
  p_team_id          BIGINT,
  p_from             DATE,
  p_to               DATE,
  p_campaign_ids     BIGINT[] DEFAULT NULL,
  p_client_ids       UUID[]   DEFAULT NULL,
  p_exclude_weekends BOOLEAN  DEFAULT FALSE,
  p_compare          BOOLEAN  DEFAULT FALSE
)
RETURNS TABLE (
  period    TEXT,
  stat_date DATE,
  sent      BIGINT,
  prospects BIGINT,
  replies   BIGINT,
  human     BIGINT,
  positive  BIGINT,
  bounces   BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH periods AS (
    SELECT 'current'::TEXT AS period, p_from AS f, p_to AS t
    UNION ALL
    SELECT 'previous', p_from - (p_to - p_from + 1), p_from - 1
    WHERE p_compare
  ),
  scoped AS (
    SELECT c.id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  -- Every day in range, so the chart has no holes.
  days AS (
    SELECT pr.period, d::DATE AS stat_date
    FROM periods pr,
         generate_series(pr.f, pr.t, INTERVAL '1 day') d
    -- Cold email volume collapses at weekends; including them makes every week
    -- read as a crash followed by a recovery. Filtering here rather than in the
    -- client because it changes the x domain, not just what's drawn.
    WHERE NOT p_exclude_weekends
       OR EXTRACT(ISODOW FROM d) < 6
  )
  SELECT
    dy.period,
    dy.stat_date,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'sent' AND s.stat_date = dy.stat_date), 0)::BIGINT,
    -- Per-day distinct leads. Does NOT sum to the Prospects KPI -- see the note
    -- in migration 005; that is correct behaviour for a distinct count.
    COALESCE((SELECT SUM(d.total_leads_contacted) FROM campaign_day_stats d
              WHERE d.team_id = p_team_id
                AND d.campaign_id IN (SELECT id FROM scoped)
                AND d.stat_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification AND NOT r.automated_reply
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification AND r.interested
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'bounces' AND s.stat_date = dy.stat_date), 0)::BIGINT
  FROM days dy
  ORDER BY dy.period, dy.stat_date;
$$;

NOTIFY pgrst, 'reload schema';

INSERT INTO schema_migrations (version) VALUES ('011_analytics_timeseries')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
