-- 050 — retract the campaign guesses that named the wrong client.
--
-- 049 stopped the resolver making these. This withdraws the ones already
-- published, which the resolver will never revisit because they carry a
-- `resolution` and its queue only picks up rows that have none.
--
-- The rule is the same one the resolver now applies: an outcome whose campaign
-- was GUESSED by email keeps that campaign only if the campaign belongs to the
-- client MasterInbox named. Otherwise the campaign is withdrawn and the row is
-- stamped `client_mismatch`.
--
-- Nothing is deleted and no outcome stops counting. Each one still belongs to
-- its client — that came from the feed and is not in question. It simply stops
-- claiming a campaign we cannot prove earned it.
--
-- Expected effect, measured before writing this: ~719 rows lose a campaign they
-- should never have had, including 27 of the 33 credited hires. The Attribution
-- tab's "credited to a campaign" figure will FALL, and that is the fix working
-- — it was counting confident wrong answers.
--
-- Rows the FEED attributed are untouched. Those were right 94% of the time and
-- are not a guess.

BEGIN;

UPDATE outcome_events o
   SET resolved_campaign_id = NULL,
       resolution           = 'client_mismatch',
       resolved_at          = NOW()
  FROM campaign_clients cc
 WHERE cc.campaign_id = o.resolved_campaign_id
   AND o.resolution IN ('email', 'lead_id')
   AND o.resolved_client_id IS NOT NULL
   AND cc.client_id IS DISTINCT FROM o.resolved_client_id;

/*
 * A guess against an outcome whose owner we could not resolve at all is also
 * unprovable — there is nothing to check it against. One row.
 */
UPDATE outcome_events
   SET resolved_campaign_id = NULL,
       resolution           = 'client_mismatch',
       resolved_at          = NOW()
 WHERE resolution IN ('email', 'lead_id')
   AND resolved_client_id IS NULL
   AND resolved_campaign_id IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('050_retract_mismatched_guesses')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
