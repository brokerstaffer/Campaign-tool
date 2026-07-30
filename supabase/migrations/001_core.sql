-- 001_core.sql — tenancy, migration bookkeeping, and sync state.
--
-- Conventions used by every migration in this directory:
--   * Each table carries a `-- CACHE OF EB` or `-- LOCALLY OWNED` comment.
--     A cache table may be truncated and rebuilt from EmailBison without data
--     loss. A locally-owned table may not.
--   * `team_id` is the physical tenancy key (an EmailBison workspace).
--     `client_id` (migration 006) is the REPORTING key. With one workspace,
--     team_id is effectively constant — it exists so a second workspace is
--     additive rather than a schema migration.
--   * Any migration creating or changing an RPC ends with
--     `NOTIFY pgrst, 'reload schema';`

BEGIN;

-- LOCALLY OWNED. Applied-migration ledger, so partial application is auditable.
-- Migrations 003 and 005 are deliberately held until scripts/probe-eb.mjs has
-- answered the questions that decide their column definitions; this table is
-- how we know what is and isn't in place.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- LOCALLY OWNED. One row per EmailBison workspace visible to the token.
CREATE TABLE IF NOT EXISTS teams (
  id         BIGINT PRIMARY KEY,              -- EmailBison workspace id
  name       TEXT   NOT NULL,
  -- All date bucketing resolves through this. Q3 confirms whether EmailBison's
  -- dates are UTC or workspace-local; this is the bucket we present in.
  timezone   TEXT   NOT NULL DEFAULT 'America/New_York',
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- LOCALLY OWNED. Cursor bookkeeping: one MUTABLE row per (job, team).
-- This is the answer to "what do I re-fetch?" for every cron and every backfill.
CREATE TABLE IF NOT EXISTS sync_state (
  job_name             TEXT   NOT NULL,
  team_id              BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  cursor_date          DATE,          -- date-cursor jobs (daily_series, day_stats)
  cursor_id            BIGINT,        -- id-cursor jobs (replies)
  watermark_at         TIMESTAMPTZ,   -- time-cursor jobs
  last_run_at          TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_error           TEXT,
  -- Circuit breaker. At >= 5 the job stops retrying and the UI shows a
  -- staleness strip, rather than hammering a broken endpoint all night.
  consecutive_failures SMALLINT NOT NULL DEFAULT 0,
  -- NULL = idle. Non-NULL and old = a crashed run whose lock is safe to steal.
  -- This is what stops two overlapping cron invocations double-writing.
  running_since        TIMESTAMPTZ,
  PRIMARY KEY (job_name, team_id)
);

-- LOCALLY OWNED. APPEND-ONLY run log. Two tables rather than one because the
-- cursor must be a cheap mutable upsert, while the history must not overwrite
-- itself — you cannot debug a sync from a row that erases its own past.
CREATE TABLE IF NOT EXISTS sync_runs (
  id           BIGSERIAL PRIMARY KEY,
  job_name     TEXT NOT NULL,
  team_id      BIGINT,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT,          -- 'ok' | 'error' | 'partial'
  rows_written INTEGER,
  api_calls    INTEGER,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_runs_recent
  ON sync_runs (job_name, started_at DESC);

INSERT INTO schema_migrations (version) VALUES ('001_core')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
