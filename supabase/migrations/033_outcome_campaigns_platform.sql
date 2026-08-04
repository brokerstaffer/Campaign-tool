-- 033 — the Platform filter must reach the campaign table too.
--
-- Caught on screen: with platforms=instantly the funnel showed 649 Instantly
-- outcomes while the table below it still listed EmailBison campaigns and their
-- 365 outcomes — none of which are Instantly's. The filter reached
-- analytics_outcome_totals and stopped there.
--
-- Filtering here is nearly a no-op by construction, and that is the point:
-- Instantly outcomes carry resolved_campaign_id = NULL (025), so selecting
-- Instantly now correctly yields NO campaign rows rather than a list that
-- silently ignores the filter. An empty table under a populated funnel is the
-- honest answer — it says "this platform earns outcomes we cannot credit to a
-- campaign here", which is exactly the situation.

BEGIN;

DROP FUNCTION IF EXISTS analytics_outcome_campaigns(BIGINT, DATE, DATE, UUID[]);

CREATE FUNCTION analytics_outcome_campaigns(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL,
  p_platforms  TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  campaign_id   BIGINT,
  campaign_name TEXT,
  client_name   TEXT,
  sent          BIGINT,
  outcomes      BIGINT,
  people        BIGINT,
  by_type       JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT o.resolved_campaign_id AS cid, o.email, o.event_type
    FROM outcome_events o
    JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_platforms  IS NULL OR o.source_platform = ANY(p_platforms))
  ),
  per_type AS (
    SELECT cid, event_type, COUNT(*) AS n FROM scoped GROUP BY cid, event_type
  ),
  totals AS (
    SELECT cid, COUNT(*) AS outcomes, COUNT(DISTINCT lower(email)) AS people
    FROM scoped GROUP BY cid
  ),
  volume AS (
    SELECT d.campaign_id, SUM(d.emails_sent) AS sent
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
    GROUP BY d.campaign_id
  )
  SELECT
    t.cid, c.name, cl.name,
    COALESCE(v.sent, 0)::BIGINT,
    t.outcomes, t.people,
    (SELECT jsonb_object_agg(p.event_type, p.n) FROM per_type p WHERE p.cid = t.cid)
  FROM totals t
  LEFT JOIN campaigns c        ON c.id = t.cid
  LEFT JOIN campaign_clients m ON m.campaign_id = t.cid
  LEFT JOIN clients cl         ON cl.id = m.client_id
  LEFT JOIN volume v           ON v.campaign_id = t.cid
  ORDER BY t.outcomes DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('033_outcome_campaigns_platform')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
