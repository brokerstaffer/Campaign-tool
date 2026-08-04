-- 026 — the raw event list behind the Attribution tab.
--
-- Every other analytics RPC here returns an aggregate. This one returns rows,
-- because the ask is to see all 1,923 outcomes the feed sends, not only what
-- survives attribution. Two consequences:
--
--   * It pages in SQL. PostgREST truncates a .select() at 1000 rows SILENTLY,
--     so a raw list built that way would look complete at exactly the size where
--     it stops being complete (CLAUDE.md rule 7).
--   * It returns total_count alongside every page, so "1,923" on screen is
--     counted rather than inferred from how many rows came back.
--
-- Filters are applied here rather than client-side for the same reason: filtering
-- a truncated page is filtering the wrong set.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_outcome_events(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_types      TEXT[]   DEFAULT NULL,
  p_platforms  TEXT[]   DEFAULT NULL,
  p_client_ids UUID[]   DEFAULT NULL,
  p_search     TEXT     DEFAULT NULL,
  p_limit      INT      DEFAULT 100,
  p_offset     INT      DEFAULT 0
)
RETURNS TABLE (
  id                  TEXT,
  email               TEXT,
  event_type          TEXT,
  occurred_at         TIMESTAMPTZ,
  source_platform     TEXT,
  source_campaign_ref TEXT,
  resolution          TEXT,
  campaign_id         BIGINT,
  campaign_name       TEXT,
  client_name         TEXT,
  total_count         BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT o.*
    FROM outcome_events o
    LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND (p_types     IS NULL OR o.event_type      = ANY(p_types))
      AND (p_platforms IS NULL OR o.source_platform = ANY(p_platforms))
      AND (p_client_ids IS NULL OR cc.client_id     = ANY(p_client_ids))
      AND (p_search    IS NULL OR o.email ILIKE '%' || p_search || '%')
  )
  SELECT
    s.id,
    s.email,
    s.event_type,
    s.occurred_at,
    s.source_platform,
    s.source_campaign_ref,
    -- NULL means the resolver has not looked yet; the UI must not render that
    -- the same as "looked and found nothing".
    COALESCE(s.resolution, 'pending'),
    s.resolved_campaign_id,
    c.name,
    cl.name,
    COUNT(*) OVER ()
  FROM scoped s
  LEFT JOIN campaigns c        ON c.id  = s.resolved_campaign_id
  LEFT JOIN campaign_clients m ON m.campaign_id = s.resolved_campaign_id
  LEFT JOIN clients cl         ON cl.id = m.client_id
  ORDER BY s.occurred_at DESC, s.id
  LIMIT p_limit OFFSET p_offset;
$$;

/** The type + platform vocabularies actually present, for the filter controls. */
CREATE OR REPLACE FUNCTION analytics_outcome_facets(
  p_team_id BIGINT,
  p_from    DATE,
  p_to      DATE
)
RETURNS TABLE (kind TEXT, value TEXT, n BIGINT)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT * FROM outcome_events
    WHERE team_id = p_team_id AND NOT voided
      AND occurred_at::date BETWEEN p_from AND p_to
  )
  SELECT 'type', event_type, COUNT(*) FROM scoped GROUP BY 2
  UNION ALL
  SELECT 'platform', source_platform, COUNT(*) FROM scoped GROUP BY 2
  ORDER BY 1, 3 DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('026_outcome_events_list')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
