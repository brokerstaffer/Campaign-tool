-- 019_offer_sequences.sql — an offer is a SEQUENCE, not just a label.
--
-- Reframes §6.2 on the product owner's direction: "fetch the sequences from all
-- the campaigns and then combine them according to the offer and then show them
-- here with stats. we can name the offer here and then we can copy these
-- sequence to any campaign from here with just one click."
--
-- So an offer is three things at once:
--   1. a grouping of campaigns          (campaign_offers, migration 018)
--   2. the combined performance of them (analytics_offer_rows, migration 018)
--   3. a REUSABLE SEQUENCE you can deploy to a new campaign in one click
--
-- Only (3) is new, and it needs one thing: which campaign's sequence represents
-- the offer. Campaigns attached to an offer drift — someone edits one, adds a
-- step to another — so "the offer's sequence" has to be a decision, not an
-- average. Highest volume is the default because it is the version that has
-- actually been proven, but it is overridable.

BEGIN;

ALTER TABLE offers
  -- NOT a foreign key with CASCADE: if the source campaign is deleted the offer
  -- and its history must survive, falling back to the highest-volume campaign
  -- still attached. Losing a label because its exemplar was tidied up would be
  -- the same mistake as deleting a client taking its campaigns with it.
  ADD COLUMN IF NOT EXISTS source_campaign_id BIGINT;

/*
 * Per-step performance for a range, with every copy tag on the step attached.
 *
 * Deliberately returns ROWS PER STEP rather than a finished grouping, because
 * the UI groups by a user-chosen SET of dimensions ("+ Add Dimension") and the
 * number of combinations is not known here.
 *
 * This is the one place the app aggregates in the client rather than in SQL,
 * and it is exempt from that rule for a specific reason: the row count is
 * bounded by the number of sequence steps in the workspace (284 today, and it
 * grows with campaigns, not with sending volume). The PostgREST 1000-row cap
 * that the rule exists to avoid is not reachable by data growth here — and the
 * daily stats behind each row ARE still summed in SQL.
 */
CREATE OR REPLACE FUNCTION analytics_copy_steps(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  sequence_step_id BIGINT,
  campaign_id      BIGINT,
  campaign_name    TEXT,
  offer_id         UUID,
  subject          TEXT,
  sent             BIGINT,
  replies          BIGINT,
  positive         BIGINT,
  bounced          BIGINT,
  tags             JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT
      s.sequence_step_id,
      s.campaign_id,
      SUM(s.sent)           AS sent,
      SUM(s.unique_replies) AS replies,
      SUM(s.interested)     AS positive,
      SUM(s.bounced)        AS bounced
    FROM campaign_step_stats_daily s
    JOIN campaign_clients cc ON cc.campaign_id = s.campaign_id
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      -- Templates and internal lists are not evidence about what copy works.
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR s.campaign_id = ANY(p_campaign_ids))
    GROUP BY s.sequence_step_id, s.campaign_id
  )
  SELECT
    x.sequence_step_id,
    x.campaign_id,
    c.name,
    co.offer_id,
    st.email_subject,
    x.sent, x.replies, x.positive, x.bounced,
    COALESCE(
      (SELECT jsonb_object_agg(t.dimension, t.value)
         FROM copy_tags t
        WHERE t.sequence_step_id = x.sequence_step_id),
      '{}'::jsonb
    )
  FROM scoped x
  LEFT JOIN campaigns       c  ON c.id = x.campaign_id
  LEFT JOIN campaign_offers co ON co.campaign_id = x.campaign_id
  LEFT JOIN sequence_steps  st ON st.id = x.sequence_step_id
  ORDER BY x.sent DESC;
$$;

/*
 * The sequence that represents an offer, plus the campaigns it came from.
 *
 * Resolves source_campaign_id, falling back to the highest-volume attached
 * campaign so an offer always has a deployable sequence without anyone having
 * to nominate one.
 */
CREATE OR REPLACE FUNCTION analytics_offer_source(p_team_id BIGINT)
RETURNS TABLE (
  offer_id           UUID,
  source_campaign_id BIGINT,
  source_name        TEXT,
  chosen             BOOLEAN,
  step_count         BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT
      o.id AS offer_id,
      c.id AS campaign_id,
      c.name,
      (o.source_campaign_id = c.id) AS chosen,
      ROW_NUMBER() OVER (
        PARTITION BY o.id
        ORDER BY (o.source_campaign_id = c.id) DESC NULLS LAST,
                 COALESCE(c.lifetime_emails_sent, 0) DESC
      ) AS rank
    FROM offers o
    JOIN campaign_offers co ON co.offer_id = o.id
    JOIN campaigns c        ON c.id = co.campaign_id
    WHERE o.team_id = p_team_id
  )
  SELECT
    r.offer_id,
    r.campaign_id,
    r.name,
    COALESCE(r.chosen, FALSE),
    (SELECT COUNT(*) FROM sequence_steps s WHERE s.campaign_id = r.campaign_id)
  FROM ranked r
  WHERE r.rank = 1;
$$;

INSERT INTO schema_migrations (version) VALUES ('019_offer_sequences')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
