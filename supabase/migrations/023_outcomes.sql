-- 023_outcomes.sql — the Attribution tab (spec §7).
--
-- "What happened after the reply. Turns email activity into business outcomes."
--
-- Fed by an external outcomes API, polled incrementally like every other source
-- here. Probed before writing this, against the live feed (1,923 events):
--
--   event_type          introduction 1171 · no_show 258 · we_they_rejected 227
--                       keep_warm 101 · interview 74 · phone_screen 41
--                       phone_screen_scheduled 35 · interview_scheduled 13
--                       hired 3
--   campaign_id         456 integers, 644 UUIDs, 823 null
--   emailbison_lead_id  457 integers, 1,466 null
--
-- THE CAMPAIGN_ID FIELD CARRIES TWO DIFFERENT KINDS OF IDENTIFIER. 456 rows hold
-- an EmailBison campaign id (an integer, joinable); 644 hold a UUID from the
-- source system, which means nothing here. Consuming that column naively would
-- attribute 644 outcomes to campaigns that do not exist. So the raw value is
-- kept verbatim in `source_campaign_ref` and only an INTEGER is promoted to
-- `resolved_campaign_id`.
--
-- Everything else is resolved the way the spec asks — "credited back to the
-- campaign that FIRST contacted that person" — by looking the email up in
-- EmailBison and taking the earliest send. Sampled 20 unresolvable rows against
-- the live API: 19 found a lead, so coverage should be high, and the ones that
-- do not resolve are reported rather than hidden.

BEGIN;

-- CACHE OF the outcomes API + LOCALLY OWNED resolution.
CREATE TABLE IF NOT EXISTS outcome_events (
  -- Their id, verbatim. Stable and unique, which is what makes re-polling safe.
  id                  TEXT PRIMARY KEY,
  team_id             BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,

  email               TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  -- Their updated_at, and the cursor for incremental polling.
  source_updated_at   TIMESTAMPTZ,
  -- A retracted outcome must stop counting. All false today; handled anyway,
  -- because the failure mode is a meeting that counts forever.
  voided              BOOLEAN NOT NULL DEFAULT FALSE,

  -- What they sent, kept exactly as received so a wrong guess here is always
  -- traceable back to the source rather than silently rewritten.
  source_campaign_ref TEXT,
  source_lead_id      BIGINT,

  -- What WE resolved. NOT a foreign key: an outcome for a campaign that has
  -- since been deleted is still a real outcome, and the row must survive it.
  resolved_campaign_id BIGINT,
  -- provided  — they sent an integer EmailBison campaign id
  -- lead_id   — resolved from the EmailBison lead they sent
  -- email     — resolved by looking the address up in EmailBison
  -- unresolved— no campaign could be found; counted, never attributed
  resolution          TEXT,
  resolved_at         TIMESTAMPTZ,

  synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outcomes_range
  ON outcome_events (team_id, occurred_at) WHERE NOT voided;
CREATE INDEX IF NOT EXISTS idx_outcomes_campaign
  ON outcome_events (resolved_campaign_id, occurred_at) WHERE NOT voided;
-- The work queue for the resolver, exactly like idx_replies_untimed.
CREATE INDEX IF NOT EXISTS idx_outcomes_unresolved
  ON outcome_events (team_id, occurred_at DESC) WHERE resolution IS NULL;
CREATE INDEX IF NOT EXISTS idx_outcomes_email ON outcome_events (team_id, lower(email));

/*
 * Outcomes by type for a range, with the funnel's own ordering.
 *
 * Stage order is data, not a guess made at render time: a funnel that cannot
 * say phone_screen comes before hired is just a bar chart.
 */
CREATE OR REPLACE FUNCTION analytics_outcome_totals(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  event_type   TEXT,
  events       BIGINT,
  people       BIGINT,
  attributed   BIGINT,
  unattributed BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.event_type,
    COUNT(*),
    COUNT(DISTINCT lower(o.email)),
    COUNT(*) FILTER (WHERE o.resolved_campaign_id IS NOT NULL),
    COUNT(*) FILTER (WHERE o.resolved_campaign_id IS NULL)
  FROM outcome_events o
  LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
  WHERE o.team_id = p_team_id
    AND NOT o.voided
    AND o.occurred_at::date BETWEEN p_from AND p_to
    -- A client filter can only apply to outcomes we managed to attribute;
    -- unattributed ones are excluded rather than silently credited.
    AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
    AND (p_campaign_ids IS NULL OR o.resolved_campaign_id = ANY(p_campaign_ids))
  GROUP BY o.event_type
  ORDER BY COUNT(*) DESC;
$$;

/** One row per campaign that produced outcomes, for the "which campaigns produce RESULTS" table. */
CREATE OR REPLACE FUNCTION analytics_outcome_campaigns(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL
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
    SELECT o.*
    FROM outcome_events o
    JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  volume AS (
    SELECT d.campaign_id, SUM(d.emails_sent) AS sent
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
    GROUP BY d.campaign_id
  )
  SELECT
    s.resolved_campaign_id,
    c.name,
    cl.name,
    COALESCE(MAX(v.sent), 0),
    COUNT(*),
    COUNT(DISTINCT lower(s.email)),
    jsonb_object_agg(s.event_type, s.n)
  FROM (
    SELECT resolved_campaign_id, email, event_type, COUNT(*) OVER () AS ignore_me,
           COUNT(*) AS n
    FROM scoped
    GROUP BY resolved_campaign_id, email, event_type
  ) s
  LEFT JOIN campaigns c        ON c.id = s.resolved_campaign_id
  LEFT JOIN campaign_clients m ON m.campaign_id = s.resolved_campaign_id
  LEFT JOIN clients cl         ON cl.id = m.client_id
  LEFT JOIN volume v           ON v.campaign_id = s.resolved_campaign_id
  GROUP BY s.resolved_campaign_id, c.name, cl.name
  ORDER BY COUNT(*) DESC;
$$;

/** How complete the attribution is — the number that says whether to trust the rest. */
CREATE OR REPLACE FUNCTION analytics_outcome_coverage(
  p_team_id BIGINT,
  p_from    DATE,
  p_to      DATE
)
RETURNS TABLE (
  total        BIGINT,
  attributed   BIGINT,
  unattributed BIGINT,
  pending      BIGINT,
  by_method    JSONB
)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE o.resolved_campaign_id IS NOT NULL),
    COUNT(*) FILTER (WHERE o.resolution IS NOT NULL AND o.resolved_campaign_id IS NULL),
    -- Not yet looked at by the resolver: honestly different from "we looked and
    -- could not find it".
    COUNT(*) FILTER (WHERE o.resolution IS NULL),
    COALESCE(
      (SELECT jsonb_object_agg(x.resolution, x.n)
         FROM (SELECT COALESCE(resolution,'pending') AS resolution, COUNT(*) AS n
                 FROM outcome_events
                WHERE team_id = p_team_id AND NOT voided
                  AND occurred_at::date BETWEEN p_from AND p_to
                GROUP BY 1) x),
      '{}'::jsonb
    )
  FROM outcome_events o
  WHERE o.team_id = p_team_id
    AND NOT o.voided
    AND o.occurred_at::date BETWEEN p_from AND p_to;
$$;

ALTER TABLE outcome_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome_events FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON outcome_events FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('023_outcomes')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
