-- 008_campaign_exclusion.sql — excluding non-client campaigns from analytics.
--
-- Some campaigns are not a client's work: templates, internal routing lists and
-- test campaigns. Observed in the live workspace:
--   Template Zillow Flex - CST / EST / MST / PST
--   Interested ZF / Interested NO ZF (4 variants)
--   Not Interested - All Clients
--   Front Range Realty - OpsLabs Test
--   Test Client / New Test Client
--
-- Decision: EXCLUDE them from analytics entirely.
--
-- KNOWN AND ACCEPTED CONSEQUENCE: the dashboard's Sent will no longer equal
-- what EmailBison reports for the workspace, because those campaigns' volume is
-- removed. This is a deliberate choice for a cleaner client view. The
-- reconciliation script must compare against the SUM over non-excluded
-- campaigns, not the workspace aggregate, or it will report a false drift
-- forever.
--
-- Modelled as a flag on the mapping rather than on `campaigns`, because it is a
-- reporting decision about the campaign, not a fact EmailBison told us — and
-- `campaigns` is a rebuildable cache that a resync would overwrite.

BEGIN;

ALTER TABLE campaign_clients
  ADD COLUMN IF NOT EXISTS excluded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS exclude_reason TEXT;

-- Excluded campaigns are skipped by every analytics RPC, so the index that
-- matters is the one over what remains.
CREATE INDEX IF NOT EXISTS idx_cc_included
  ON campaign_clients (client_id) WHERE NOT excluded;

-- The triage queue is "needs a human": unassigned or ambiguous, but NOT the
-- ones deliberately excluded. Without this the queue would never reach zero and
-- would stop being a signal that something needs attention.
DROP INDEX IF EXISTS idx_cc_needs_attention;
CREATE INDEX IF NOT EXISTS idx_cc_needs_attention
  ON campaign_clients (campaign_id)
  WHERE NOT excluded AND (client_id IS NULL OR ambiguous);

COMMENT ON COLUMN campaign_clients.excluded IS
  'Not a client campaign (template, internal list, test). Omitted from all '
  'analytics. Dashboard totals will not match the EmailBison workspace total.';

INSERT INTO schema_migrations (version) VALUES ('008_campaign_exclusion')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
