-- 006_clients.sql — the reporting dimension and the campaign→client mapping.
--
-- All clients share one EmailBison workspace and are identified by their name
-- appearing in the campaign name ("The Keyes Company + Nicole",
-- "C21 Results - Elite Team 2", "54 Realty (9) - Hillsborough"). EmailBison has
-- no client concept, so this is LOCALLY OWNED data that the entire product
-- groups by.

BEGIN;

-- LOCALLY OWNED. Maintained on /clients.
CREATE TABLE IF NOT EXISTS clients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id    BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name       TEXT   NOT NULL,           -- display name
  slug       TEXT   NOT NULL,           -- normalised, for stable URLs
  -- Other spellings seen in campaign names. Absorbs legacy naming without
  -- having to rename anything inside EmailBison.
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  -- Default 'contains': the client name may appear ANYWHERE in the campaign
  -- name, not just as a prefix. 'prefix' and 'exact' are the per-client escape
  -- hatch for a short or generic name that would otherwise over-match.
  match_mode TEXT   NOT NULL DEFAULT 'contains'
    CHECK (match_mode IN ('contains','prefix','exact')),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, slug)
);

-- LOCALLY OWNED. The RESOLVED mapping — persisted, never recomputed at read
-- time. Three reasons:
--   1. every analytics RPC becomes a join instead of string-matching 183 names
--      per request;
--   2. an operator override sticks instead of being silently undone by the
--      next sync;
--   3. renaming a client tomorrow does not rewrite last quarter's grouping.
CREATE TABLE IF NOT EXISTS campaign_clients (
  campaign_id  BIGINT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  -- NULL = Unassigned. Rendered as a first-class row in the Clients table, not
  -- filtered out: if unmatched campaigns were hidden, the client totals would
  -- quietly fail to sum to the KPI band.
  client_id    UUID REFERENCES clients(id) ON DELETE SET NULL,
  -- 'manual' rows are NEVER overwritten by the auto-matcher.
  match_method TEXT NOT NULL DEFAULT 'auto'
    CHECK (match_method IN ('auto','manual')),
  matched_on   TEXT,             -- the name/alias that won, for auditability
  confidence   NUMERIC(3,2),     -- auto only: matched tokens / total tokens
  -- More than one client matched with equal token length. Left unassigned and
  -- surfaced for a human rather than guessed — a silent mis-attribution is
  -- worse than a visible gap, because nobody goes looking for it.
  ambiguous    BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_client ON campaign_clients (client_id);
-- The /clients triage queue: unassigned or ambiguous campaigns needing a human.
CREATE INDEX IF NOT EXISTS idx_cc_needs_attention
  ON campaign_clients (campaign_id)
  WHERE client_id IS NULL OR ambiguous;

INSERT INTO schema_migrations (version) VALUES ('006_clients')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
