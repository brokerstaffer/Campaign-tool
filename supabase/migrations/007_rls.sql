-- 007_rls.sql — deny-by-default row level security.
--
-- WHY THIS EXISTS
--
-- Supabase grants the `anon` and `authenticated` roles access to tables in the
-- public schema by default. The anon key is designed to be embedded in a
-- browser and is effectively public. Verified before writing this migration:
-- an anon-key GET on /rest/v1/campaigns returned 200. Every table created in
-- 001-006 was world-readable to anyone holding that key.
--
-- THE FIX
--
-- Enable RLS on every table and define NO policies. In Postgres, RLS with no
-- policy denies all access — and `service_role` BYPASSES RLS entirely, which is
-- the only credential this application ever uses (see src/lib/supabase/server.ts:
-- there is no browser Supabase client and no anon key anywhere in the app).
--
-- So this closes the hole without changing a single query.
--
-- This migration is IDEMPOTENT and loops over all public tables, so re-running
-- it after adding tables is the correct way to cover them. Do that at the end
-- of any migration that creates a table.

BEGIN;

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'          -- ordinary tables only
      AND NOT c.relrowsecurity     -- skip ones already covered
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.relname);
    -- FORCE also applies RLS to the table owner, so a future policy can't be
    -- quietly sidestepped by whichever role happens to own the table.
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.relname);
    RAISE NOTICE 'RLS enabled on %', target.relname;
  END LOOP;
END $$;

-- Belt and braces: revoke the default grants outright. RLS alone is sufficient,
-- but a future policy added for one table shouldn't silently open it to anon.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('007_rls')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
