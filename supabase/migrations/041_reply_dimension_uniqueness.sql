-- 041 — stop the default reply dimensions from duplicating.
--
-- 027 declared UNIQUE (team_id, client_id, key) and relied on ON CONFLICT DO
-- NOTHING to make the seed idempotent. IT IS NOT, because the default rows have
-- client_id = NULL and Postgres treats NULLs as DISTINCT in a unique
-- constraint: two rows with the same (team_id, key) and a NULL client_id do not
-- conflict, so every re-run inserted another copy.
--
-- Found by reading the API output rather than the table — every dimension came
-- back twice, which would have drawn every breakdown card on the Replies view
-- twice. The migration was run more than once while being written, which is
-- exactly the situation "ON CONFLICT DO NOTHING" was there to survive.
--
-- Fixed with a PARTIAL unique index, which does constrain NULL client_id rows
-- because the NULL is in the predicate rather than in the key.

BEGIN;

-- Keep the earliest of each duplicate set; they are identical apart from id.
DELETE FROM reply_dimensions a
USING reply_dimensions b
WHERE a.client_id IS NULL
  AND b.client_id IS NULL
  AND a.team_id = b.team_id
  AND a.key = b.key
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reply_dimensions_default
  ON reply_dimensions (team_id, key) WHERE client_id IS NULL;

INSERT INTO schema_migrations (version) VALUES ('041_reply_dimension_uniqueness')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
