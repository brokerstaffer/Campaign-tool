-- 027 — the Replies view (REQ "VIEW 3", spec §5.5).
--
-- "What do our repliers have in common?" — the question that says where to
-- point the next campaign.
--
-- THE CHEAPEST DIMENSION IS THE ONE WE ALREADY HAVE. Brokerage means the CLIENT
-- we are recruiting for, and every reply already reaches one:
--
--     replies.campaign_id -> campaign_clients.client_id -> clients.name
--
-- Measured on the live table: 7,813 of 7,989 replies (97.8%) resolve, the
-- remainder being the deliberately-excluded internal campaigns. So that whole
-- dimension needs no lead data, no sync job, and no new column — and because
-- campaign_clients is PERSISTED rather than recomputed (CLAUDE.md rule 8),
-- renaming a client tomorrow cannot silently rewrite last quarter's bars.
--
-- The other dimensions do need the lead. Two facts make that cheap:
--
--   * Only 6,675 distinct people have ever replied, out of 69,794 leads. The
--     breakdowns are OF REPLIERS, so the other 63,000 are irrelevant.
--   * EmailBison already carries every attribute asked for, on
--     `custom_variables`. Verified against live leads: `office city`,
--     `sales volume`, `mls affiliation`, `top producing city`, `estimated gci`,
--     `closed transactions`, `average sales price`, all populated 15/15 in the
--     sample, plus `company` at the top level.
--
-- `company` is NOT the client. It is where the replying agent works TODAY
-- (EXP Realty, Compass, Keller Williams). Both are worth grouping by and they
-- answer different questions, so both are dimensions here and they are named
-- so nobody confuses them.

BEGIN;

-- CACHE OF EB. Only leads that have actually replied.
CREATE TABLE IF NOT EXISTS leads (
  id            BIGINT PRIMARY KEY,
  team_id       BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email         TEXT,
  first_name    TEXT,
  last_name     TEXT,
  -- The replier's CURRENT employer. Never the client.
  company       TEXT,
  title         TEXT,
  status        TEXT,
  eb_created_at TIMESTAMPTZ,
  eb_updated_at TIMESTAMPTZ,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_company ON leads (team_id, company);

/*
 * CACHE OF EB. Long, not wide, and deliberately so.
 *
 * EmailBison's custom_variables are per-workspace and will change without
 * warning. Long format makes a new variable a row rather than a migration, and
 * makes the per-client dimension config below a matter of naming a key.
 */
CREATE TABLE IF NOT EXISTS lead_attributes (
  lead_id       BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  team_id       BIGINT NOT NULL,
  name          TEXT NOT NULL,
  -- Verbatim, exactly as EmailBison sent it. A bad parse must always be
  -- traceable back to the source rather than silently rewritten.
  value         TEXT,
  /*
   * Parsed number, where the raw value is money or a count ("$1,001,000" -> 1001000).
   * NULL means "could not parse", which is NOT the same as zero and must never
   * be bucketed as though it were — an unparseable sales volume is reported in
   * its own bucket, not folded into the lowest band.
   */
  value_numeric NUMERIC,
  PRIMARY KEY (lead_id, name)
);

-- The grouping index: every breakdown is "one attribute name, grouped by value".
CREATE INDEX IF NOT EXISTS idx_lead_attr_name ON lead_attributes (team_id, name, lead_id);

/*
 * LOCALLY OWNED. Which breakdowns a client sees.
 *
 * §5.5: "These groupings are configurable per client. Brokerage, office, county
 * and sales volume are the ones that matter for this client; another client can
 * be set up with their own list without a rebuild."
 *
 * client_id NULL = the default set, used by every client with no list of its own.
 */
CREATE TABLE IF NOT EXISTS reply_dimensions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  client_id  UUID REFERENCES clients(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  -- client         -> the client the campaign belongs to (no lead needed)
  -- lead_field     -> a column on leads, e.g. company
  -- lead_attribute -> a row in lead_attributes, e.g. 'office city'
  source     TEXT NOT NULL CHECK (source IN ('client', 'lead_field', 'lead_attribute')),
  source_key TEXT,
  -- NULL = group by the raw value. 'currency_bands' = bucket value_numeric.
  bucket     TEXT,
  -- `position` is a reserved word in a RETURNS TABLE signature, so the column
  -- is named to match what the function can actually return.
  sort_position INT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (team_id, client_id, key)
);

-- The default set. Named so the two "brokerage" senses can never be confused.
INSERT INTO reply_dimensions (team_id, client_id, key, label, source, source_key, bucket, sort_position)
VALUES
  (2, NULL, 'brokerage',    'Brokerage (client)',   'client',         NULL,                 NULL,             1),
  (2, NULL, 'company',      'Current brokerage',    'lead_field',     'company',            NULL,             2),
  (2, NULL, 'location',     'Location',             'lead_attribute', 'office city',        NULL,             3),
  (2, NULL, 'sales_volume', 'Sales volume',         'lead_attribute', 'sales volume',       'currency_bands', 4),
  (2, NULL, 'mls',          'MLS affiliation',      'lead_attribute', 'mls affiliation',    NULL,             5),
  (2, NULL, 'top_city',     'Top producing city',   'lead_attribute', 'top producing city', NULL,             6)
ON CONFLICT (team_id, client_id, key) DO NOTHING;

/*
 * Sales-volume bands.
 *
 * Two scalar functions rather than one returning (label, order): a
 * set-returning function cannot be used inside CASE, and the breakdown below
 * needs exactly that. Kept as a pair so a band edit changes both together.
 *
 * The order matters as much as the label — sorting these alphabetically puts
 * "$1M – $2.5M" before "Under $1M" and makes the chart read backwards.
 */
CREATE OR REPLACE FUNCTION currency_band_label(n NUMERIC)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    -- Unparseable or absent. NOT folded into the lowest band: "we do not know
    -- this agent's volume" and "this agent sells under $1M" are different facts.
    WHEN n IS NULL    THEN 'Unknown'
    WHEN n < 1000000  THEN 'Under $1M'
    WHEN n < 2500000  THEN '$1M - $2.5M'
    WHEN n < 5000000  THEN '$2.5M - $5M'
    WHEN n < 10000000 THEN '$5M - $10M'
    WHEN n < 25000000 THEN '$10M - $25M'
    ELSE                   '$25M+'
  END;
$$;

CREATE OR REPLACE FUNCTION currency_band_order(n NUMERIC)
RETURNS INT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN n IS NULL    THEN 99   -- Unknown sorts last, never first.
    WHEN n < 1000000  THEN 1
    WHEN n < 2500000  THEN 2
    WHEN n < 5000000  THEN 3
    WHEN n < 10000000 THEN 4
    WHEN n < 25000000 THEN 5
    ELSE                   6
  END;
$$;

/*
 * One breakdown: replies grouped by one dimension.
 *
 * p_positive_only implements the §5.5 toggle. Every dimension goes through this
 * one function so the toggle, the date range and the client filter cannot drift
 * between charts.
 *
 * A reply whose lead carries no value for the dimension is counted as 'Unknown'
 * rather than dropped — otherwise the bars silently stop summing to the reply
 * count and the card lies about its own coverage.
 */
CREATE OR REPLACE FUNCTION analytics_reply_breakdown(
  p_team_id       BIGINT,
  p_from          DATE,
  p_to            DATE,
  p_dimension     TEXT,
  p_client_ids    UUID[]   DEFAULT NULL,
  p_campaign_ids  BIGINT[] DEFAULT NULL,
  p_positive_only BOOLEAN  DEFAULT FALSE,
  p_limit         INT      DEFAULT 12
)
RETURNS TABLE (value TEXT, replies BIGINT, positive BIGINT, sort_order INT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM reply_dimensions
   WHERE team_id = p_team_id AND key = p_dimension AND active
   ORDER BY client_id NULLS LAST LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT r.id, r.lead_id, r.interested, cc.client_id, cl.name AS client_name
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR r.interested)
  ),
  labelled AS (
    SELECT
      s.id,
      s.interested,
      CASE d.source
        WHEN 'client'     THEN COALESCE(s.client_name, 'Unassigned')
        WHEN 'lead_field' THEN COALESCE(NULLIF(l.company, ''), 'Unknown')
        ELSE CASE
          WHEN d.bucket = 'currency_bands' THEN currency_band_label(la.value_numeric)
          ELSE COALESCE(NULLIF(la.value, ''), 'Unknown')
        END
      END AS val,
      CASE
        WHEN d.bucket = 'currency_bands' THEN currency_band_order(la.value_numeric)
        ELSE 0
      END AS ord
    FROM scoped s
    LEFT JOIN leads l ON d.source IN ('lead_field') AND l.id = s.lead_id
    LEFT JOIN lead_attributes la
           ON d.source = 'lead_attribute' AND la.lead_id = s.lead_id AND la.name = d.source_key
  )
  SELECT lb.val, COUNT(*), COUNT(*) FILTER (WHERE lb.interested), MIN(lb.ord)::INT
  FROM labelled lb
  GROUP BY lb.val
  -- Banded dimensions read in band order; everything else reads biggest-first.
  ORDER BY CASE WHEN d.bucket = 'currency_bands' THEN MIN(lb.ord) END,
           COUNT(*) DESC
  LIMIT p_limit;
END;
$$;

/** The dimensions a given client should see, defaults included. */
CREATE OR REPLACE FUNCTION analytics_reply_dimensions(
  p_team_id   BIGINT,
  p_client_id UUID DEFAULT NULL
)
RETURNS TABLE (key TEXT, label TEXT, source TEXT, bucket TEXT, sort_position INT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (d.key) d.key, d.label, d.source, d.bucket, d.sort_position
  FROM reply_dimensions d
  WHERE d.team_id = p_team_id AND d.active
    AND (d.client_id IS NULL OR d.client_id = p_client_id)
  -- A client-specific row wins over the default of the same key.
  ORDER BY d.key, d.client_id NULLS LAST, d.sort_position;
$$;

ALTER TABLE leads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads            FORCE  ROW LEVEL SECURITY;
ALTER TABLE lead_attributes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_attributes  FORCE  ROW LEVEL SECURITY;
ALTER TABLE reply_dimensions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reply_dimensions FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON leads, lead_attributes, reply_dimensions FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('027_reply_dimensions')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
