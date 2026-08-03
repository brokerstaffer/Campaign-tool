-- 022_campaign_deleted_at.sql — notice when a campaign disappears upstream.
--
-- sync-entities upserted campaigns and never reconciled removals, so a campaign
-- deleted in EmailBison lived on in the cache forever: still in the campaign
-- picker, still in the filter list, still selectable as a copy target. Two
-- throwaway campaigns deleted during testing were still being offered minutes
-- later while two genuinely new ones were missing.
--
-- SOFT delete, not hard. campaigns is the parent of campaign_day_stats,
-- campaign_step_stats_daily, sequence_steps and campaign_clients, all ON DELETE
-- CASCADE — so removing the row would silently erase that campaign's entire
-- history from every chart and total. The sends happened; the analytics should
-- still be able to see them. Only the pickers and lists need it gone.

BEGIN;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Every list query filters on this, and almost every row is NULL.
CREATE INDEX IF NOT EXISTS idx_campaigns_live
  ON campaigns (team_id, status) WHERE deleted_at IS NULL;

COMMENT ON COLUMN campaigns.deleted_at IS
  'Set by sync-entities when EmailBison stops returning the campaign. Cleared '
  'if it comes back — EmailBison deletes asynchronously ("queued for deletion"), '
  'so a campaign can briefly vanish and reappear, and a one-way flag would '
  'permanently hide a live campaign over a transient blip.';

INSERT INTO schema_migrations (version) VALUES ('022_campaign_deleted_at')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
