-- 053 — who a campaign has actually contacted.
--
-- THE GAP. `leads` is populated only for people who REPLIED — about 6,700 of
-- ~69,800 — because syncLeads builds its work list from replies.lead_id. And
-- nothing anywhere records which leads belong to which campaign: there is no
-- column, no join table, and EmailBison exposes no endpoint for it. The lead
-- list is workspace-wide and carries no campaign; /api/campaigns/{id} carries a
-- total_leads count and nothing else.
--
-- THE SOURCE, probed before this was written (read-only, 2026-08-06):
-- GET /api/scheduled-emails?status=sent — 258,291 rows across 105 campaigns,
-- 17,287 cursor pages. Each row carries campaign_id, sequence_step_id, sent_at,
-- per-send opens/clicks/replies, the sending inbox, AND a fully nested lead
-- including custom_variables. Verified: `campaign_ids[]`, `pagination_type=cursor`
-- and the `scheduled_date_local` filter all compose in ONE request, and every
-- one of 150 sampled rows carried a lead with its custom variables.
--
-- CURSOR MODE IS MANDATORY. Page mode caps at 1,000 pages (15,000 rows) and
-- stops SILENTLY; campaign 55 alone has 18,575 sends, so a page-mode walk would
-- look like it worked and be short by thousands. Also probed: ids are NOT
-- monotonic with sent_at, so an id watermark cannot stand in for the cursor.
--
-- WHY RAW SENDS AND NOT ONLY A ROLLUP. `opens`, `clicks` and `replies` on a send
-- row are MUTABLE — they accrue for days after sent_at. A rollup merged by
-- summation cannot re-read a send to pick up a late open without double-counting
-- the original, and a watermark that prevents the double-count also prevents the
-- late open from ever arriving. Either way the number ends up silently low.
-- "A missed poll window is just re-fetched" (CLAUDE.md) only holds if re-fetching
-- CONVERGES, and summation does not. Keyed on the scheduled-email id, an upsert
-- is last-write-wins and a trailing re-walk repairs exactly.
--
-- Cost of that choice, stated plainly: ~258K rows today, ~6,300/day, so ~2.3M
-- rows a year. This is the largest table in the database. It is NOT the case
-- CLAUDE.md rejected for the webhook design — that was rejected because
-- /api/campaign-events/stats already served the aggregate. Nothing serves this.

BEGIN;

-- CACHE OF EB (GET /api/scheduled-emails?status=sent). Raw send facts.
CREATE TABLE IF NOT EXISTS campaign_lead_sends (
  id               BIGINT PRIMARY KEY,          -- the scheduled-email id
  team_id          BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  campaign_id      BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  /*
   * No FK to `leads`. Same reasoning as campaign_step_stats_daily's missing FK
   * to sequence_steps (005): a lead deleted upstream between the send feed and
   * the lead upsert would cost a whole page of send history to a constraint
   * violation, which is worse than an orphan row.
   */
  lead_id          BIGINT NOT NULL,
  sequence_step_id BIGINT,
  sender_email_id  BIGINT,
  sent_at          TIMESTAMPTZ,
  thread_reply     BOOLEAN,
  -- Mutable counters. Refreshed by the trailing re-walk, never summed
  -- incrementally — see the header.
  opens            INTEGER NOT NULL DEFAULT 0,
  unique_opens     INTEGER NOT NULL DEFAULT 0,
  clicks           INTEGER NOT NULL DEFAULT 0,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cls_pair   ON campaign_lead_sends (campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_cls_recent ON campaign_lead_sends (team_id, sent_at DESC);

/*
 * CACHE OF EB, DERIVED from campaign_lead_sends. One row per (campaign, lead) —
 * campaign membership, which is the thing that did not exist anywhere before.
 *
 * NOTE WHAT IS ABSENT: replies, positive, bounces. The feed offers all three and
 * they are deliberately not stored. The Replies tab, the KPI band and every
 * analytics RPC count replies from local `replies` rows; a second count from a
 * second feed sitting on the same screen would not agree with them — EmailBison's
 * own two counters already disagree 29 vs 105 (docs/eb-api-findings.md). Rule 3:
 * one authority per metric family. They are joined at read time instead.
 */
CREATE TABLE IF NOT EXISTS campaign_leads (
  campaign_id     BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  team_id         BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  lead_id         BIGINT NOT NULL,
  first_sent_at   TIMESTAMPTZ,
  last_sent_at    TIMESTAMPTZ,
  sends           INTEGER NOT NULL DEFAULT 0,
  /*
   * The furthest STEP reached, resolved through sequence_steps.step_order.
   * A variant is not a step (043/044): it has order NULL and occupies its
   * parent's position, so a send of a variant counts as reaching the parent's
   * order rather than a step of its own.
   */
  step_reached    INTEGER,
  last_step_id    BIGINT,
  sender_email_id BIGINT,          -- the inbox that sent most recently
  opens           INTEGER NOT NULL DEFAULT 0,
  unique_opens    INTEGER NOT NULL DEFAULT 0,
  clicks          INTEGER NOT NULL DEFAULT 0,
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_cl_recent ON campaign_leads (campaign_id, last_sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_cl_lead   ON campaign_leads (team_id, lead_id);

/*
 * LOCALLY OWNED. One cursor per campaign.
 *
 * `sync_state` holds ONE cursor per (job, team) and the backfill needs 89 live
 * ones, plus a per-campaign "the full walk finished" flag — which is what lets a
 * steady-state run switch from the full walk to the trailing window without
 * re-deriving that every night.
 */
CREATE TABLE IF NOT EXISTS campaign_send_sync (
  campaign_id       BIGINT PRIMARY KEY REFERENCES campaigns(id) ON DELETE CASCADE,
  team_id           BIGINT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  -- NULL + backfilled_at NULL = never started. NULL + backfilled_at set = done.
  backfill_cursor   TEXT,
  backfilled_at     TIMESTAMPTZ,
  last_sent_at_seen TIMESTAMPTZ,
  pages_read        INTEGER NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

/*
 * The Leads screen probes `replies` per (campaign, lead) to show that person's
 * replies. 003 indexes (campaign_id, received_date) and (team_id, lead_id,
 * date_received); neither serves this shape.
 */
CREATE INDEX IF NOT EXISTS idx_replies_campaign_lead
  ON replies (campaign_id, lead_id) WHERE tracked_reply;

/**
 * Recomputes campaign_leads for the given campaigns, from the send facts.
 *
 * A full re-group per campaign rather than an incremental merge, so it is
 * idempotent by construction and cannot drift from the facts it derives from.
 */
CREATE OR REPLACE FUNCTION refresh_campaign_leads(
  p_team_id      BIGINT,
  p_campaign_ids BIGINT[]
) RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO campaign_leads AS cl (
    campaign_id, team_id, lead_id, first_sent_at, last_sent_at, sends,
    step_reached, last_step_id, sender_email_id, opens, unique_opens, clicks, computed_at
  )
  SELECT
    s.campaign_id,
    p_team_id,
    s.lead_id,
    MIN(s.sent_at),
    MAX(s.sent_at),
    COUNT(*)::INTEGER,
    -- A variant resolves to its parent's position; see the column comment.
    MAX(COALESCE(st.step_order, parent.step_order))::INTEGER,
    (ARRAY_AGG(s.sequence_step_id ORDER BY s.sent_at DESC NULLS LAST))[1],
    (ARRAY_AGG(s.sender_email_id  ORDER BY s.sent_at DESC NULLS LAST))[1],
    COALESCE(SUM(s.opens), 0)::INTEGER,
    COALESCE(SUM(s.unique_opens), 0)::INTEGER,
    COALESCE(SUM(s.clicks), 0)::INTEGER,
    NOW()
  FROM campaign_lead_sends s
  LEFT JOIN sequence_steps st     ON st.id = s.sequence_step_id
  LEFT JOIN sequence_steps parent ON parent.id = st.variant_from_step_id
  WHERE s.team_id = p_team_id
    AND s.campaign_id = ANY(p_campaign_ids)
  GROUP BY s.campaign_id, s.lead_id
  ON CONFLICT (campaign_id, lead_id) DO UPDATE SET
    first_sent_at   = EXCLUDED.first_sent_at,
    last_sent_at    = EXCLUDED.last_sent_at,
    sends           = EXCLUDED.sends,
    step_reached    = EXCLUDED.step_reached,
    last_step_id    = EXCLUDED.last_step_id,
    sender_email_id = EXCLUDED.sender_email_id,
    opens           = EXCLUDED.opens,
    unique_opens    = EXCLUDED.unique_opens,
    clicks          = EXCLUDED.clicks,
    computed_at     = NOW();

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

ALTER TABLE campaign_lead_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_lead_sends FORCE  ROW LEVEL SECURITY;
ALTER TABLE campaign_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_leads      FORCE  ROW LEVEL SECURITY;
ALTER TABLE campaign_send_sync  ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_sync  FORCE  ROW LEVEL SECURITY;
REVOKE ALL ON campaign_lead_sends, campaign_leads, campaign_send_sync FROM anon, authenticated;

INSERT INTO schema_migrations (version) VALUES ('053_campaign_leads')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
