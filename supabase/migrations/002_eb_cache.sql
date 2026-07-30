-- 002_eb_cache.sql — local mirror of EmailBison entities.
--
-- Everything here is a CACHE: droppable and rebuildable from the API. Nothing
-- in this file may hold data that does not exist upstream.
--
-- Note there is no `leads` table. It existed in an earlier design only to power
-- a Replies breakdown view that is out of scope; syncing ~100K leads is a
-- day-long job with no v1 consumer, so it is deliberately deferred.

BEGIN;

-- CACHE OF EB (GET /api/campaigns).
CREATE TABLE IF NOT EXISTS campaigns (
  id                   BIGINT PRIMARY KEY,
  team_id              BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name                 TEXT   NOT NULL,
  type                 TEXT,
  -- Six-value vocabulary: draft | launching | active | paused | completed |
  -- archived. Intentionally NOT a CHECK constraint: EmailBison owns this
  -- vocabulary and will extend it, and an unknown status must land in the
  -- 'unknown' bucket in the UI rather than fail an insert and stall a sync.
  status               TEXT,
  tags                 JSONB  NOT NULL DEFAULT '[]'::jsonb,
  max_emails_per_day   INTEGER,
  total_leads          INTEGER,
  -- EmailBison's LIFETIME cumulative counter. Kept for the campaign list only.
  -- NEVER use it for a range metric — it is overwritten on every sync and says
  -- nothing about any particular window.
  lifetime_emails_sent INTEGER,
  eb_created_at        TIMESTAMPTZ,
  eb_updated_at        TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_team ON campaigns (team_id, status);
-- Used by the client matcher, which re-runs only for campaigns whose name moved.
CREATE INDEX IF NOT EXISTS idx_campaigns_updated ON campaigns (eb_updated_at);

-- CACHE OF EB (GET /api/campaigns/v1.1/{id}/sequence-steps).
-- The join target that makes per-step and per-variant rollups possible, and
-- what the inline email panel renders from — so expanding a step is a local
-- read, not a live EmailBison call per click.
CREATE TABLE IF NOT EXISTS sequence_steps (
  id                   BIGINT PRIMARY KEY,   -- EmailBison sequence_step id
  campaign_id          BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  team_id              BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  sequence_id          BIGINT,
  step_order           INTEGER,
  email_subject        TEXT,
  -- Stored RAW, with spintax intact. The Preview/Spintax toggle needs the
  -- unrolled source; rendering is a client concern.
  email_body           TEXT,
  wait_in_days         INTEGER,
  is_variant           BOOLEAN NOT NULL DEFAULT FALSE,
  variant_from_step_id BIGINT,               -- NULL on the parent step
  thread_reply         BOOLEAN NOT NULL DEFAULT FALSE,
  attachments          JSONB  NOT NULL DEFAULT '[]'::jsonb,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_steps_campaign
  ON sequence_steps (campaign_id, step_order);
CREATE INDEX IF NOT EXISTS idx_steps_variant
  ON sequence_steps (variant_from_step_id);

-- CACHE OF EB (GET /api/sender-emails).
-- v1 needs this only as a join target for the sender_email_ids[] filter on the
-- daily-series endpoint, and as the fallback for identifying our own messages
-- in a conversation thread (Q16). The Infrastructure tab consumes it properly.
CREATE TABLE IF NOT EXISTS sender_emails (
  id          BIGINT PRIMARY KEY,
  team_id     BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT   NOT NULL,
  name        TEXT,
  domain      TEXT,        -- derived from email when EmailBison omits it
  provider    TEXT,        -- google | microsoft | unknown, derived from `type`
  status      TEXT,
  daily_limit INTEGER,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sender_domain ON sender_emails (team_id, domain);
-- Case-insensitive lookup: the Q16 direction fallback matches a thread's
-- from_email_address against this, and header casing is not dependable.
CREATE INDEX IF NOT EXISTS idx_sender_email_lower
  ON sender_emails (team_id, lower(email));

INSERT INTO schema_migrations (version) VALUES ('002_eb_cache')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
