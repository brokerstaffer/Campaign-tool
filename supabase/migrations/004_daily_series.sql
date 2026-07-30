-- 004_daily_series.sql — the cached per-day series.
--
-- This one table backs the entire Charts sub-view AND the Sent / Bounces KPIs.
-- Filled by /api/cron/sync-daily-series via the adapter in
-- src/lib/emailbison/daily-series.ts.
--
-- Not gated on the probe: `stat_date` is stored exactly as EmailBison returns
-- it, so the Q3 timezone answer changes how we LABEL a day, not how we store
-- one. (The gated case is `replies.received_date` in 003, which converts a
-- timestamp to a date and therefore has to know the zone.)

BEGIN;

-- CACHE OF EB. Long and narrow: one row per (scope, day, metric).
CREATE TABLE IF NOT EXISTS eb_daily_series (
  team_id     BIGINT  NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- 0 = the workspace-wide roll-up row. Storing per-campaign rows is what lets
  -- the Campaigns filter be a WHERE clause instead of an API fan-out on every
  -- filter change.
  campaign_id BIGINT  NOT NULL,
  stat_date   DATE    NOT NULL,
  -- Long format rather than one column per metric, for one reason: EmailBison
  -- will eventually add an eighth series, and that should be a new ROW, not a
  -- migration. Unmapped labels are logged by the adapter, never silently
  -- dropped -- that warning is the drift detector.
  metric      TEXT    NOT NULL
    CHECK (metric IN ('sent','replies','bounces','unsubscribes',
                      'positive','opens_total','opens_unique')),
  value       INTEGER NOT NULL,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, campaign_id, stat_date, metric)
);

-- Covering index: the range scan reads value + campaign_id without a heap hit.
CREATE INDEX IF NOT EXISTS idx_eds_range
  ON eb_daily_series (team_id, stat_date, metric)
  INCLUDE (campaign_id, value);

COMMENT ON TABLE eb_daily_series IS
  'Cache of EmailBison daily series. ~183 campaigns x 7 metrics x 365 days '
  '= ~468K rows/year. Rebuildable: a full year is 2 API calls.';

INSERT INTO schema_migrations (version) VALUES ('004_daily_series')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
