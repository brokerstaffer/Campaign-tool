-- 014_campaign_audit_log.sql — the record behind every campaign write.
--
-- Spec §9: "Everything in this section changes what real prospects receive, so
-- every action is deliberate, confirmed, and recorded." §9.2 promises an
-- Activity tab: "a dated record of every change anyone has made to this
-- campaign — what changed, and what it was before."
--
-- `before_state` is the whole point. EmailBison has no undo and no history: a
-- resumed campaign cannot be returned to `completed`, and a replaced sequence
-- is gone. This table is the only place the previous value survives, which is
-- what makes a mistaken action visible and, for settings, reversible.

BEGIN;

-- LOCALLY OWNED. Append-only. Never truncated — it is the audit trail.
CREATE TABLE IF NOT EXISTS campaign_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  team_id      BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- NOT a foreign key to campaigns: the record of a delete must outlive the
  -- campaign it deleted, which is exactly when you most want to read it.
  campaign_id  BIGINT NOT NULL,
  campaign_name TEXT,           -- denormalised for the same reason
  action       TEXT   NOT NULL, -- pause | resume | archive | duplicate | update | tag | untag
  actor        TEXT   NOT NULL, -- session email; 'system' for sync-initiated writes
  -- Whether EmailBison actually applied it. §9.5: "If a change can't be applied
  -- on the sending platform, the dashboard says so with the actual reason, and
  -- does not show the change as saved."
  status       TEXT   NOT NULL DEFAULT 'ok',  -- ok | error
  error        TEXT,
  before_state JSONB,
  after_state  JSONB,
  -- Groups the rows written by one bulk action, so "who paused 40 campaigns at
  -- once" is one question rather than forty.
  batch_id     UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cal_campaign
  ON campaign_audit_log (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_recent
  ON campaign_audit_log (team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_batch
  ON campaign_audit_log (batch_id) WHERE batch_id IS NOT NULL;

-- Re-run 007_rls.sql after this: it loops over every public table, and a new
-- table without RLS is readable by the anon key.
ALTER TABLE campaign_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_audit_log FORCE ROW LEVEL SECURITY;
REVOKE ALL ON campaign_audit_log FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('014_campaign_audit_log')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
