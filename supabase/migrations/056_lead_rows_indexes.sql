-- 056 — the two indexes the Leads screen actually needs.
--
-- Measured with EXPLAIN ANALYZE on campaign 92 (2,434 leads), 285,935 buffer
-- hits for a 50-row page:
--
--   1. The reply probe ran 2,434 index scans against idx_replies_campaign
--      (campaign_id, received_date) — the WRONG index. 053 added
--      (campaign_id, lead_id) but made it PARTIAL on `tracked_reply`, and the
--      probe cannot use it: it also has to see bounce notifications, which are
--      not tracked replies, so it never filters on that column. A partial index
--      is only usable when the query proves the predicate.
--
--   2. `leads` was sequentially scanned — all 27,589 rows, growing to ~70,000
--      as the send-feed walk fills it in — to hash-join 2,434 of them.
--
-- The lesson from 029 was that the fix is never "add an index on a hunch";
-- it is to look at the plan. The plan named both of these.

BEGIN;

DROP INDEX IF EXISTS idx_replies_campaign_lead;

-- Not partial. The Leads screen counts replies AND bounce notifications for a
-- lead, so it never constrains tracked_reply and could not use a partial index.
CREATE INDEX IF NOT EXISTS idx_replies_campaign_lead
  ON replies (campaign_id, lead_id);

-- Lets the join reach a lead by id per row rather than scanning the table.
CREATE INDEX IF NOT EXISTS idx_leads_team_id
  ON leads (team_id, id);

ANALYZE replies;
ANALYZE leads;
ANALYZE campaign_leads;

INSERT INTO schema_migrations (version) VALUES ('056_lead_rows_indexes')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
