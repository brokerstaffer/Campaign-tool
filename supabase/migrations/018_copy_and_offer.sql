-- 018_copy_and_offer.sql — the Copy & Offer tab (spec §6).
--
-- "Which words work, and which offers work. This is the tab that decides what
-- you write next."
--
-- Two independent halves that share a screen:
--
--   §6.1/6.3  Copy dimensions — every email tagged along seven axes, then
--             performance grouped by the values of one axis.
--   §6.2      Offers — Zillow Flex, realtor.com VIP — as things in their own
--             right, attached to campaigns, measured per offer.
--
-- The offer half works the moment an offer is created. The copy half needs the
-- 284 sequence steps tagged before it says anything, so every read path here
-- reports how much of the volume is actually tagged. A dimension table computed
-- over 8% of sends that presents itself as "how your copy performs" is worse
-- than an empty one.

BEGIN;

-- LOCALLY OWNED. EmailBison has no concept of any of this.
--
-- One row per (step, dimension). The seven dimensions are fixed — they are the
-- spec's list and the UI's tabs — but their VALUES are open: §6.3 says values
-- "can be picked from the existing list or added as you go", so this is text,
-- not an enum. A new value is a new row, never a migration.
CREATE TABLE IF NOT EXISTS copy_tags (
  sequence_step_id BIGINT NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  team_id          BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  dimension        TEXT   NOT NULL,
  value            TEXT   NOT NULL,
  -- §6.3: "Where tags have been suggested automatically, they're marked as such
  -- so someone can confirm or correct them." A suggestion that cannot be told
  -- from a human judgement silently turns a guess into evidence.
  source           TEXT   NOT NULL DEFAULT 'manual',  -- manual | suggested
  confirmed_at     TIMESTAMPTZ,
  actor            TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sequence_step_id, dimension),
  CONSTRAINT copy_tags_dimension_known CHECK (
    dimension IN ('subject_line','opening','preposition','social_proof','cta','tone','structure')
  ),
  CONSTRAINT copy_tags_source_known CHECK (source IN ('manual','suggested'))
);

CREATE INDEX IF NOT EXISTS idx_copy_tags_dim ON copy_tags (team_id, dimension, value);

-- LOCALLY OWNED. §6.2: offers are tracked "as things in their own right, not
-- just as campaign names".
CREATE TABLE IF NOT EXISTS offers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT   NOT NULL,
  niche      TEXT,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, name)
);

-- One offer per campaign. A campaign sells one thing; if that stops being true
-- this becomes a join table, which is an additive change.
CREATE TABLE IF NOT EXISTS campaign_offers (
  campaign_id BIGINT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  offer_id    UUID   NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  actor       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_campaign_offers_offer ON campaign_offers (offer_id);

/*
 * Copy performance for ONE dimension (§6.1).
 *
 * Measured over campaign_step_stats_daily, so it is date-ranged and agrees with
 * the rest of the analytics side. The lifetime counters on sequence_steps would
 * have been easier and would not tie to anything.
 *
 * `coverage` is not decoration. It reports the share of range volume that
 * carries a tag on this dimension, so a table built from 8% of sends cannot
 * present itself as how the copy performs.
 */
CREATE OR REPLACE FUNCTION analytics_copy_dimension(
  p_team_id      BIGINT,
  p_dimension    TEXT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[] DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  value        TEXT,
  steps        BIGINT,
  sent         BIGINT,
  replies      BIGINT,
  positive     BIGINT,
  bounced      BIGINT,
  reply_rate   NUMERIC,
  positive_rate NUMERIC,
  bounce_rate  NUMERIC,
  suggested    BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT s.*
    FROM campaign_step_stats_daily s
    JOIN campaign_clients cc ON cc.campaign_id = s.campaign_id
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      -- Excluded campaigns are templates and internal lists; their copy is not
      -- a data point about what works.
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR s.campaign_id = ANY(p_campaign_ids))
  )
  SELECT
    t.value,
    COUNT(DISTINCT s.sequence_step_id),
    SUM(s.sent),
    SUM(s.unique_replies),
    SUM(s.interested),
    SUM(s.bounced),
    -- NULL, never 0, when nothing was sent: "no data" and "a 0% reply rate" are
    -- different facts and DASH is how the first reaches the DOM.
    CASE WHEN SUM(s.sent) > 0 THEN SUM(s.unique_replies)::NUMERIC / SUM(s.sent) END,
    -- Positive over REPLIES, matching the KPI band's definition.
    CASE WHEN SUM(s.unique_replies) > 0
         THEN SUM(s.interested)::NUMERIC / SUM(s.unique_replies) END,
    CASE WHEN SUM(s.sent) > 0 THEN SUM(s.bounced)::NUMERIC / SUM(s.sent) END,
    COUNT(DISTINCT s.sequence_step_id) FILTER (WHERE t.source = 'suggested')
  FROM scoped s
  JOIN copy_tags t
    ON t.sequence_step_id = s.sequence_step_id
   AND t.dimension = p_dimension
  GROUP BY t.value
  ORDER BY SUM(s.sent) DESC;
$$;

/** How much of the range's volume carries a tag on this dimension. */
CREATE OR REPLACE FUNCTION analytics_copy_coverage(
  p_team_id      BIGINT,
  p_dimension    TEXT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[] DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (tagged_sent BIGINT, total_sent BIGINT, tagged_steps BIGINT, total_steps BIGINT)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT s.*
    FROM campaign_step_stats_daily s
    JOIN campaign_clients cc ON cc.campaign_id = s.campaign_id
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR s.campaign_id = ANY(p_campaign_ids))
  )
  SELECT
    COALESCE(SUM(s.sent) FILTER (WHERE t.sequence_step_id IS NOT NULL), 0),
    COALESCE(SUM(s.sent), 0),
    COUNT(DISTINCT s.sequence_step_id) FILTER (WHERE t.sequence_step_id IS NOT NULL),
    COUNT(DISTINCT s.sequence_step_id)
  FROM scoped s
  LEFT JOIN copy_tags t
    ON t.sequence_step_id = s.sequence_step_id
   AND t.dimension = p_dimension;
$$;

/*
 * Offer performance (§6.2), optionally rolled up by client so you can see
 * "which offer is worth expanding, and which niche is worth prioritising".
 *
 * Campaign-level, from campaign_day_stats — offers attach to campaigns, not to
 * steps.
 */
CREATE OR REPLACE FUNCTION analytics_offer_rows(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  offer_id      UUID,
  offer_name    TEXT,
  niche         TEXT,
  campaigns     BIGINT,
  sent          BIGINT,
  replies       BIGINT,
  positive      BIGINT,
  bounced       BIGINT,
  reply_rate    NUMERIC,
  positive_rate NUMERIC,
  bounce_rate   NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    o.id, o.name, o.niche,
    COUNT(DISTINCT d.campaign_id),
    COALESCE(SUM(d.emails_sent), 0),
    COALESCE(SUM(d.unique_replies), 0),
    COALESCE(SUM(d.interested), 0),
    COALESCE(SUM(d.bounced), 0),
    CASE WHEN SUM(d.emails_sent) > 0
         THEN SUM(d.unique_replies)::NUMERIC / SUM(d.emails_sent) END,
    CASE WHEN SUM(d.unique_replies) > 0
         THEN SUM(d.interested)::NUMERIC / SUM(d.unique_replies) END,
    CASE WHEN SUM(d.emails_sent) > 0
         THEN SUM(d.bounced)::NUMERIC / SUM(d.emails_sent) END
  FROM offers o
  LEFT JOIN campaign_offers co ON co.offer_id = o.id
  LEFT JOIN campaign_day_stats d
         ON d.campaign_id = co.campaign_id
        AND d.stat_date BETWEEN p_from AND p_to
  LEFT JOIN campaign_clients cc ON cc.campaign_id = co.campaign_id
  WHERE o.team_id = p_team_id
    AND (cc.excluded IS NULL OR cc.excluded = FALSE)
    AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
  GROUP BY o.id, o.name, o.niche
  ORDER BY COALESCE(SUM(d.emails_sent), 0) DESC;
$$;

-- 007_rls loops over every public table; new tables must be locked down too.
ALTER TABLE copy_tags       ENABLE ROW LEVEL SECURITY;
ALTER TABLE copy_tags       FORCE  ROW LEVEL SECURITY;
ALTER TABLE offers          ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers          FORCE  ROW LEVEL SECURITY;
ALTER TABLE campaign_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_offers FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON copy_tags, offers, campaign_offers FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('018_copy_and_offer')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
