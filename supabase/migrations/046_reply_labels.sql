-- 046 — Positive comes from MasterInbox's labels, not EmailBison's flag.
--
-- THE PROBLEM, MEASURED. MasterInbox mirrors a label decision back into
-- EmailBison's `interested` flag, but ONLY for the label literally named
-- "Interested". Three labels carry positive sentiment there, and the largest of
-- them -- "Introduction" -- never sets the flag at all. So most positive replies
-- have been invisible to every number in this dashboard since it was built.
--
-- Measured against the live feed, all-time, tracked non-bounce replies:
--
--   Positive today (replies.interested)        118
--   Positive from MasterInbox labels           389   <- Introduction 304 + Interested 85
--   Negative today (nothing writes it)           0
--   Negative from MasterInbox labels          2,239
--
-- 389 is exactly the figure the reference product this dashboard was specified
-- against showed. docs/remaining-work.md records the gap as blocker M1, "cannot
-- be fixed by code -- needs to know what counts as positive". This is the
-- answer: it was never a definition problem, it was a source problem.
--
-- NO NEW TABLE. `sentiment`, `sentiment_source` and `sentiment_at` have existed
-- since 003, are documented there as locally owned, are deliberately excluded
-- from every sync's upsert column list so a sweep cannot wipe them -- and have
-- never been written to by anything. This is what they were built for.
--
-- `replies.interested` KEEPS SYNCING and stops being read. It becomes a
-- cross-check: a widening gap between it and the label means the round-trip into
-- EmailBison has broken, which is worth seeing rather than silently losing.

BEGIN;

/*
 * MasterInbox is a fourth source, beside the operator, an AI classifier, and
 * EmailBison's own flag. Naming it rather than folding it into 'manual' keeps
 * "who decided this" answerable -- the feed reports whether a human, the AI or a
 * webhook applied each label, and a number resting on AI labelling is a
 * different claim from one a person made.
 */
ALTER TABLE replies DROP CONSTRAINT IF EXISTS replies_sentiment_source_check;
ALTER TABLE replies ADD CONSTRAINT replies_sentiment_source_check
  CHECK (sentiment_source IN ('eb_interested','manual','ai','masterinbox'));

/*
 * The label's NAME, beside its sentiment.
 *
 * The sentiment drives the maths; the name is what the operator actually chose.
 * "Introduction", "Interested" and "Meetings Booked" are all positive and all
 * different, and collapsing them loses the distinction the person was making.
 *
 * It is also the drift detector: if a label's sentiment is reassigned upstream,
 * the name moves with it and we can see why a number changed, instead of
 * watching it move for no visible reason.
 */
ALTER TABLE replies ADD COLUMN IF NOT EXISTS sentiment_label TEXT;

/*
 * Which MasterInbox conversation a reply was labelled through.
 *
 * A thread carries one label and can hold several inbound replies -- 338 threads
 * do, covering 569 extra replies. Only the FIRST reply in a thread is credited,
 * or one conversation would count as several positives and overstate by ~14%.
 * Storing the thread id makes that decision auditable rather than implicit, and
 * gives the sync a stable key for "this thread's label changed".
 */
ALTER TABLE replies ADD COLUMN IF NOT EXISTS label_thread_id TEXT;

/*
 * The index on `sentiment = 'positive'` has existed since 003 and has indexed an
 * empty column ever since. It comes alive here -- no change needed, noted so the
 * next person doesn't think it was forgotten.
 */

COMMENT ON COLUMN replies.sentiment IS
  'positive|negative|neutral, from the MasterInbox label on this reply''s thread. Authoritative for Positive and Negative. NULL means NOT YET LABELLED, which is not the same as neutral.';
COMMENT ON COLUMN replies.sentiment_label IS
  'The MasterInbox label name, e.g. Introduction / Interested / Not Interested.';
COMMENT ON COLUMN replies.interested IS
  'EmailBison''s own flag. NO LONGER READ by any metric -- kept as a cross-check against the MasterInbox label; a widening gap means the round-trip into EmailBison has broken.';

INSERT INTO schema_migrations (version) VALUES ('046_reply_labels')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
