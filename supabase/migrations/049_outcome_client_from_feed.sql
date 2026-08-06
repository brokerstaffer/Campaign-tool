-- 049 — the outcomes feed now names the owning client, so stop guessing it.
--
-- THE BUG THIS FIXES, MEASURED against MasterInbox's own pipeline:
--
--   outcomes credited via a campaign the feed NAMED    466 right,  30 wrong  (94%)
--   outcomes credited via EMAIL-MATCHED first touch     36 right, 719 wrong  ( 5%)
--
-- For hires alone, 27 of the 33 we credited went to the wrong client. C21's
-- three hires were sitting under other brokerages' names.
--
-- WHY EMAIL MATCHING FAILS HERE, and why it was never going to work: the same
-- real-estate agents are prospected by many brokerages at once. First-touch
-- finds whichever campaign emailed a person earliest, which is frequently a
-- different client entirely. MattC Group is a large early campaign, so it won
-- that race constantly and accumulated 23 hires it did not earn.
--
-- This is the same failure CLAUDE.md rule 8 documents for Instantly rows —
-- "resolving by email SUCCEEDS, and credits one of our campaigns with another
-- platform's result" — except it bites `direct` rows too, and nobody noticed
-- because it also fails upward: every client's number looked plausible.
--
-- THE FIX. The feed now carries `client_id` + `client_name` on 100% of rows,
-- from MasterInbox's own pipeline entry. That is ground truth for who owns an
-- outcome, and it replaces the guess outright.

BEGIN;

/*
 * MasterInbox's client id, so the mapping survives a rename.
 *
 * The portal roster has always returned an `id`; sync-entities only ever stored
 * name and slug, so every join between the two systems has been by name. A
 * client renamed in MasterInbox would have silently become a second client
 * here. Matching on the id ends that.
 */
ALTER TABLE clients ADD COLUMN IF NOT EXISTS portal_client_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_portal_id
  ON clients (team_id, portal_client_id) WHERE portal_client_id IS NOT NULL;

/*
 * The owning client, straight from the feed.
 *
 * Deliberately NOT derived through resolved_campaign_id -> campaign_clients.
 * That chain is only as good as the campaign, and the campaign is exactly what
 * was wrong. An outcome now knows its client even when no campaign can be
 * named — which is the common case: the feed provides a campaign for 1,216 of
 * 2,100 rows but a client for all 2,100.
 */
ALTER TABLE outcome_events ADD COLUMN IF NOT EXISTS resolved_client_id UUID
  REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE outcome_events ADD COLUMN IF NOT EXISTS source_client_ref TEXT;
ALTER TABLE outcome_events ADD COLUMN IF NOT EXISTS source_client_name TEXT;

CREATE INDEX IF NOT EXISTS idx_outcome_client
  ON outcome_events (team_id, resolved_client_id, occurred_at)
  WHERE NOT voided;

COMMENT ON COLUMN outcome_events.resolved_client_id IS
  'The owning client, from MasterInbox. AUTHORITATIVE — never derive the client from resolved_campaign_id, which is guessed for rows the feed did not attribute.';
COMMENT ON COLUMN outcome_events.resolved_campaign_id IS
  'Only ever set from a campaign the FEED named, or from an email match whose campaign belongs to the same client the feed named. An email match that disagrees with the feed''s client is discarded — it was wrong 95% of the time.';

INSERT INTO schema_migrations (version) VALUES ('049_outcome_client_from_feed')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
