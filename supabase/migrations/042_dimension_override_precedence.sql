-- 042 — a client can actually turn a reply grouping off.
--
-- 027 resolved the per-client list as:
--
--   WHERE d.active                                  -- filter first
--   ORDER BY d.key, d.client_id NULLS LAST          -- then prefer the client
--
-- which makes switching one OFF for a client do nothing: the override row is
-- `active = false`, the WHERE removes it, and the still-active default is then
-- the only candidate left and wins. Caught end to end rather than in the code —
-- the API reported the override saved and the Replies view kept drawing six
-- cards.
--
-- Precedence has to be settled BEFORE activeness is judged: pick the row that
-- governs (client's if present, else default), then honour whatever it says.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_reply_dimensions(
  p_team_id   BIGINT,
  p_client_id UUID DEFAULT NULL
)
RETURNS TABLE (key TEXT, label TEXT, source TEXT, bucket TEXT, sort_position INT)
LANGUAGE sql STABLE AS $$
  WITH governing AS (
    -- One row per key: the client's if it exists, otherwise the default.
    SELECT DISTINCT ON (d.key) d.*
    FROM reply_dimensions d
    WHERE d.team_id = p_team_id
      AND (d.client_id IS NULL OR d.client_id = p_client_id)
    ORDER BY d.key, d.client_id NULLS LAST
  )
  SELECT g.key, g.label, g.source, g.bucket, g.sort_position
  FROM governing g
  WHERE g.active          -- judged only on the row that actually governs
  ORDER BY g.sort_position, g.key;
$$;

INSERT INTO schema_migrations (version) VALUES ('042_dimension_override_precedence')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
