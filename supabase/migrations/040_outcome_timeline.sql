-- 040 — the funnel as a timeline (spec §7).
--
-- "Timing is recorded so the funnel can be read as a timeline, not just a set
-- of totals."
--
-- We stored occurred_at from the first ingest and never plotted it, so the tab
-- could say 869 introductions but not whether they were rising or collapsing —
-- which is the only version of that number anyone can act on.
--
-- Weekly, not daily. Outcomes are far rarer than sends (1,630 in 90 days across
-- nine types), so a daily series is mostly zeroes with single-event spikes that
-- read as noise. Weeks give each point enough mass to mean something.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_outcome_timeline(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_platforms    TEXT[]   DEFAULT NULL
)
RETURNS TABLE (
  week          DATE,
  event_type    TEXT,
  events        BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT
      date_trunc('week', o.occurred_at)::date AS wk,
      o.event_type
    FROM outcome_events o
    LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND (p_platforms    IS NULL OR o.source_platform      = ANY(p_platforms))
      AND (p_client_ids   IS NULL OR cc.client_id           = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR o.resolved_campaign_id = ANY(p_campaign_ids))
  )
  SELECT wk, event_type, COUNT(*)
  FROM scoped
  GROUP BY wk, event_type
  ORDER BY wk, event_type;
$$;

INSERT INTO schema_migrations (version) VALUES ('040_outcome_timeline')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
