-- 005_day_stats.sql — per-day campaign and step aggregates.
--
-- WAS GATED on probe question Q6. ANSWERED 2026-07-30: a single-day range
-- (start_date == end_date) DOES return correct `sequence_step_stats`.
-- Verified on campaign 117 for 2026-07-29: sent=997, prospects=997, 3 steps
-- with real per-step numbers.
--
-- So ONE call per campaign per day fills BOTH tables: the response's top level
-- feeds campaign_day_stats, its sequence_step_stats[] array feeds
-- campaign_step_stats_daily. ~95 campaigns x 3 unstored days = ~285 calls/night.

BEGIN;

-- CACHE OF EB (POST /api/campaigns/{id}/stats, start_date == end_date == D).
CREATE TABLE IF NOT EXISTS campaign_day_stats (
  campaign_id           BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  team_id               BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  stat_date             DATE   NOT NULL,
  emails_sent           INTEGER NOT NULL DEFAULT 0,
  -- THE PROSPECTS SERIES. Q5 ANSWERED: this is DISTINCT leads contacted during
  -- the range, not leads first contacted. Verified on campaign 117 -- over 30
  -- days sent=5,449 > prospects=4,289, but within a single day sent == prospects.
  --
  -- CONSEQUENCE: SUM(daily) OVERCOUNTS a range, because a lead emailed on two
  -- days appears in both. The Prospects KPI therefore comes from ONE
  -- range-scoped call, and the chart from these daily rows, and THE TWO
  -- DELIBERATELY DO NOT TIE. That is correct for a distinct count over time.
  -- Do not "fix" it by summing.
  total_leads_contacted INTEGER NOT NULL DEFAULT 0,
  opened                INTEGER NOT NULL DEFAULT 0,
  unique_opens          INTEGER NOT NULL DEFAULT 0,
  unique_replies        INTEGER NOT NULL DEFAULT 0,
  bounced               INTEGER NOT NULL DEFAULT 0,
  unsubscribed          INTEGER NOT NULL DEFAULT 0,
  interested            INTEGER NOT NULL DEFAULT 0,
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_cds_range
  ON campaign_day_stats (team_id, stat_date) INCLUDE (campaign_id);

-- CACHE OF EB (the sequence_step_stats[] array of the same response).
-- This is what makes the Campaigns table's step level range-filterable:
-- any range is a SUM over days.
CREATE TABLE IF NOT EXISTS campaign_step_stats_daily (
  campaign_id      BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  team_id          BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- No FK to sequence_steps: EmailBison can return stats for a step that has
  -- since been deleted, and losing a day of history to a foreign key violation
  -- would be a worse outcome than an orphan row.
  sequence_step_id BIGINT NOT NULL,
  stat_date        DATE   NOT NULL,
  email_subject    TEXT,
  sent             INTEGER NOT NULL DEFAULT 0,
  leads_contacted  INTEGER NOT NULL DEFAULT 0,
  unique_opens     INTEGER NOT NULL DEFAULT 0,
  unique_replies   INTEGER NOT NULL DEFAULT 0,
  unsubscribed     INTEGER NOT NULL DEFAULT 0,
  bounced          INTEGER NOT NULL DEFAULT 0,
  interested       INTEGER NOT NULL DEFAULT 0,
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, sequence_step_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_css_range
  ON campaign_step_stats_daily (team_id, stat_date, campaign_id);

INSERT INTO schema_migrations (version) VALUES ('005_day_stats')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
