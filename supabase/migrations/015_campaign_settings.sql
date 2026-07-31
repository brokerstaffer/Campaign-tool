-- 015_campaign_settings.sql — the settings and lifetime funnel every campaign
-- detail page needs, cached alongside the rest of the campaign row.
--
-- GET /api/campaigns already returns all of these on every page of the list, so
-- storing them costs nothing extra at sync time and turns the detail page from
-- "one EmailBison round trip per view" into a single indexed read.
--
-- They are also what the Settings tab edits. Keeping them here means the form
-- renders instantly from cache and writes through after EmailBison accepts —
-- the same discipline the status actions use.

BEGIN;

ALTER TABLE campaigns
  -- CACHE OF EB. Editable via PATCH /api/campaigns/{id}/update.
  ADD COLUMN IF NOT EXISTS max_new_leads_per_day        INTEGER,
  ADD COLUMN IF NOT EXISTS plain_text                   BOOLEAN,
  ADD COLUMN IF NOT EXISTS open_tracking                BOOLEAN,
  ADD COLUMN IF NOT EXISTS can_unsubscribe              BOOLEAN,
  ADD COLUMN IF NOT EXISTS unsubscribe_text             TEXT,
  ADD COLUMN IF NOT EXISTS include_auto_replies_in_stats BOOLEAN,
  ADD COLUMN IF NOT EXISTS sequence_prioritization      TEXT,
  -- CACHE OF EB, read-only. The lifetime funnel for the Overview tab.
  --
  -- NOT usable for any date-ranged metric: these are cumulative counters, which
  -- is exactly the trap the analytics side of this app exists to avoid. The
  -- Overview tab shows lifetime totals and says so; anything windowed comes
  -- from campaign_day_stats.
  ADD COLUMN IF NOT EXISTS completion_percentage        NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS lifetime_opened              INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_unique_opens        INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_replied             INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_unique_replies      INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_bounced             INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_unsubscribed        INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_interested          INTEGER,
  ADD COLUMN IF NOT EXISTS total_leads_contacted        INTEGER,
  -- Needed to address the sequence when editing steps.
  ADD COLUMN IF NOT EXISTS sequence_id                  BIGINT;

INSERT INTO schema_migrations (version) VALUES ('015_campaign_settings')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
