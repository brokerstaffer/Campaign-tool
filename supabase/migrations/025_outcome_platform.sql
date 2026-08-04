-- 025 — campaign_id names THREE different things, not two.
--
-- 023 read the mixed-type column as "an EmailBison id, or something unusable".
-- The actual semantics, from the person who built the feed:
--
--   integer  -> an EmailBison campaign
--   UUID     -> an INSTANTLY campaign — a DIFFERENT SENDING PLATFORM
--   null     -> logged directly by the client, no campaign named
--
-- That distinction is not cosmetic. The 644 UUID rows are outcomes another
-- platform produced. First-touch-resolving them through EmailBison finds a lead
-- (most of these people are in both systems) and would credit an EmailBison
-- campaign with a result Instantly earned — the whole tab's purpose is telling
-- "which campaigns produce activity" from "which produce RESULTS", and silently
-- importing a competitor platform's wins destroys exactly that number. Worse,
-- it fails upward: EmailBison looks better than it is, so nobody investigates.
--
-- So platform is made explicit and drives what may be attributed:
--
--   emailbison — the id is ours. Credited directly.
--   instantly  — counted in the totals, shown as its own platform, and NEVER
--                credited to an EmailBison campaign.
--   direct     — no campaign named, so "which of OUR campaigns first contacted
--                this person" is a fair question. First-touch lookup applies.
--
-- This also answers the long-open Platform-filter question (plan Q11): the
-- filter is real, and this column is what makes it real.

BEGIN;

ALTER TABLE outcome_events
  ADD COLUMN IF NOT EXISTS source_platform TEXT NOT NULL DEFAULT 'direct';

-- Backfill from the shape of the raw value, which is the only evidence there is.
UPDATE outcome_events SET source_platform =
  CASE
    WHEN source_campaign_ref IS NULL              THEN 'direct'
    WHEN source_campaign_ref ~ '^[0-9]+$'         THEN 'emailbison'
    WHEN source_campaign_ref ~* '^[0-9a-f-]{36}$' THEN 'instantly'
    ELSE 'direct'
  END;

/*
 * Undo the mis-attribution already written.
 *
 * The resolver ran once before this was known and credited Instantly outcomes to
 * EmailBison campaigns by email lookup. Those rows are corrected here rather
 * than left to age out — a wrong number that is never revisited is the one that
 * gets believed.
 */
UPDATE outcome_events
   SET resolved_campaign_id = NULL,
       resolution           = 'other_platform',
       resolved_at          = NOW()
 WHERE source_platform = 'instantly';

-- The work queue: only rows whose platform makes first-touch a fair question.
DROP INDEX IF EXISTS idx_outcomes_unresolved;
CREATE INDEX idx_outcomes_unresolved
  ON outcome_events (team_id, occurred_at DESC)
  WHERE resolution IS NULL AND email IS NOT NULL AND source_platform = 'direct';

CREATE INDEX IF NOT EXISTS idx_outcomes_platform
  ON outcome_events (team_id, source_platform, occurred_at) WHERE NOT voided;

/*
 * One row per campaign that produced outcomes.
 *
 * Rewritten: 023's version grouped by (campaign, email, event_type) in a
 * subquery and then jsonb_object_agg'd the per-person counts, so every value in
 * by_type collapsed to the last person's count — it read `{"introduction": 1}`
 * for a campaign with 237 outcomes. Aggregated in one pass now.
 */
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
    SELECT o.resolved_campaign_id AS cid, o.email, o.event_type
    FROM outcome_events o
    JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
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
    t.cid,
    c.name,
    cl.name,
    COALESCE(v.sent, 0)::BIGINT,
    t.outcomes,
    t.people,
    (SELECT jsonb_object_agg(p.event_type, p.n) FROM per_type p WHERE p.cid = t.cid)
  FROM totals t
  LEFT JOIN campaigns c        ON c.id = t.cid
  LEFT JOIN campaign_clients m ON m.campaign_id = t.cid
  LEFT JOIN clients cl         ON cl.id = m.client_id
  LEFT JOIN volume v           ON v.campaign_id = t.cid
  ORDER BY t.outcomes DESC;
$$;

/*
 * Coverage — the number that says whether to trust the rest of the tab.
 *
 * Splits by platform as well as by method, because "not credited to a campaign"
 * has two completely different meanings now: an Instantly outcome is fully
 * explained, a `direct` one that found no lead is a genuine gap.
 *
 * Dropped, not replaced: the OUT parameters change, and Postgres refuses to
 * redefine a function's row type in place.
 */
DROP FUNCTION IF EXISTS analytics_outcome_coverage(BIGINT, DATE, DATE);
CREATE FUNCTION analytics_outcome_coverage(
  p_team_id BIGINT,
  p_from    DATE,
  p_to      DATE
)
RETURNS TABLE (
  total        BIGINT,
  attributed   BIGINT,
  other_platform BIGINT,
  unattributed BIGINT,
  pending      BIGINT,
  by_method    JSONB,
  by_platform  JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT * FROM outcome_events
    WHERE team_id = p_team_id AND NOT voided
      AND occurred_at::date BETWEEN p_from AND p_to
  )
  SELECT
    (SELECT COUNT(*) FROM scoped),
    (SELECT COUNT(*) FROM scoped WHERE resolved_campaign_id IS NOT NULL),
    (SELECT COUNT(*) FROM scoped WHERE source_platform = 'instantly'),
    -- Looked at, no EmailBison campaign found. The honest gap.
    (SELECT COUNT(*) FROM scoped
      WHERE resolution IS NOT NULL AND resolved_campaign_id IS NULL
        AND source_platform <> 'instantly'),
    -- Not looked at yet: different from "we looked and found nothing".
    (SELECT COUNT(*) FROM scoped WHERE resolution IS NULL),
    COALESCE((SELECT jsonb_object_agg(x.k, x.n) FROM
      (SELECT COALESCE(resolution,'pending') AS k, COUNT(*) AS n FROM scoped GROUP BY 1) x), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(y.k, y.n) FROM
      (SELECT source_platform AS k, COUNT(*) AS n FROM scoped GROUP BY 1) y), '{}'::jsonb);
$$;

/** Outcomes by type for a range. p_platforms NULL = every platform. */
DROP FUNCTION IF EXISTS analytics_outcome_totals(BIGINT, DATE, DATE, UUID[], BIGINT[]);
CREATE FUNCTION analytics_outcome_totals(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_platforms    TEXT[]   DEFAULT NULL
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
    AND (p_platforms IS NULL OR o.source_platform = ANY(p_platforms))
    -- A client or campaign filter can only apply to outcomes we attributed;
    -- the rest are excluded rather than silently credited.
    AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
    AND (p_campaign_ids IS NULL OR o.resolved_campaign_id = ANY(p_campaign_ids))
  GROUP BY o.event_type
  ORDER BY COUNT(*) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('025_outcome_platform')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
