-- 024 — an outcome does not require an email address.
--
-- 023 assumed one, because the probe's sample had one on every row. The first
-- full ingest found 5 of 1,923 with `email: null` — and those same rows carry no
-- emailbison_lead_id and no campaign_id either, so there is nothing anywhere on
-- them to attribute by.
--
-- They are still real outcomes (4 introductions and a phone screen), so the
-- choice is between dropping them and counting them as unattributable. Dropping
-- them would quietly shrink the denominator that the coverage number exists to
-- report — a total that hides its own gaps is worse than one that admits them.
-- So the column becomes nullable and the ingest stamps them `unresolved` on
-- arrival rather than queueing a lookup that has nothing to look up.

BEGIN;

ALTER TABLE outcome_events ALTER COLUMN email DROP NOT NULL;

-- The resolver's work queue must not hold rows it can never resolve — otherwise
-- it re-reads the same 5 every hour, forever.
DROP INDEX IF EXISTS idx_outcomes_unresolved;
CREATE INDEX idx_outcomes_unresolved
  ON outcome_events (team_id, occurred_at DESC)
  WHERE resolution IS NULL AND email IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES ('024_outcomes_nullable_email')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
