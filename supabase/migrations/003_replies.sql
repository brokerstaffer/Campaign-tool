-- 003_replies.sql — campaign-scoped tracked replies.
--
-- WAS GATED on probe question Q3 (timezone). ANSWERED 2026-07-30:
-- the daily series returns exactly 30 points for a 30-day inclusive range with
-- the first point equal to the requested start date, and Bounced/Interested
-- reconcile exactly against the range aggregate. There is no off-by-one, so
-- `received_date` truncates in UTC with no conversion.
--
-- SOURCE: GET /api/campaigns/{id}/replies  -- NOT GET /api/replies.
-- /api/replies is the MASTER INBOX: 1,915,806 rows, of which 959K are our own
-- outbound and most inbox rows are "Untracked Reply" with campaign_id = NULL.
-- The campaign-scoped endpoint returns only type="Tracked Reply" rows that
-- carry real campaign_id and lead_id. ~2,300 replies/30d across 95 campaigns.

BEGIN;

-- CACHE OF EB for the synced columns, LOCALLY OWNED below the marker.
CREATE TABLE IF NOT EXISTS replies (
  id                 BIGINT PRIMARY KEY,          -- EmailBison reply id
  team_id            BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  campaign_id        BIGINT REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id            BIGINT,
  sender_email_id    BIGINT,
  scheduled_email_id BIGINT,
  parent_id          BIGINT,
  folder             TEXT,
  subject            TEXT,
  text_body          TEXT,
  from_email_address TEXT,
  from_name          TEXT,
  date_received      TIMESTAMPTZ NOT NULL,
  received_date      DATE GENERATED ALWAYS AS
                       ((date_received AT TIME ZONE 'UTC')::date) STORED,
  tracked_reply      BOOLEAN NOT NULL DEFAULT TRUE,
  -- false => "Human". EmailBison's own heuristic; backs Human Replies.
  automated_reply    BOOLEAN NOT NULL DEFAULT FALSE,
  -- EmailBison's native interested flag. VERIFIED NEARLY UNUSED: 30 rows across
  -- all time workspace-wide, 7 in the last 30 days. Retained because it is the
  -- truthful upstream value, but it is NOT sufficient to reproduce the
  -- reference product's "Positive" (389 for a comparable window) -- see
  -- docs/eb-api-findings.md.
  interested         BOOLEAN NOT NULL DEFAULT FALSE,

  -- ---- LOCALLY OWNED below. The sync's upsert column list must EXCLUDE these,
  --      or every sweep would wipe the classification.
  sentiment          TEXT CHECK (sentiment IN ('positive','negative','neutral')),
  sentiment_source   TEXT CHECK (sentiment_source IN ('eb_interested','manual','ai')),
  sentiment_at       TIMESTAMPTZ,

  -- Derived: earliest send to this lead in this campaign, from
  -- GET /api/leads/{lead_id}/sent-emails. Median Reply Time =
  -- median(date_received - first_send_at). Verified working: lead 65642, first
  -- send 2026-07-27T20:29:52, reply 2026-07-30T17:43:20 -> 2.9d.
  first_send_at      TIMESTAMPTZ,
  -- Our first outbound AFTER their reply, for Median Follow-up Time.
  -- NOT POPULATED YET: EmailBison's Sent folder carries no campaign_id or
  -- lead_id, and conversation-thread returns empty (0/15 replies tested).
  -- Awaiting a dedicated endpoint from the client.
  first_followup_at  TIMESTAMPTZ,
  timing_synced_at   TIMESTAMPTZ,   -- NULL => timing not yet resolved

  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_replies_rollup
  ON replies (team_id, received_date, campaign_id);
CREATE INDEX IF NOT EXISTS idx_replies_campaign
  ON replies (campaign_id, received_date);
CREATE INDEX IF NOT EXISTS idx_replies_lead
  ON replies (team_id, lead_id, date_received);
-- Human Replies is a hot filter; a partial index keeps it off the main scan.
CREATE INDEX IF NOT EXISTS idx_replies_human
  ON replies (team_id, received_date) WHERE NOT automated_reply;
CREATE INDEX IF NOT EXISTS idx_replies_positive
  ON replies (team_id, received_date) WHERE sentiment = 'positive';
-- Work queue for the timing resolver.
CREATE INDEX IF NOT EXISTS idx_replies_untimed
  ON replies (team_id, date_received DESC) WHERE timing_synced_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('003_replies')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
