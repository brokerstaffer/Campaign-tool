-- 032 — the Copy & Offer columns both specs list and the table did not have.
--
-- WT §6.1 spells the column set out: "Sent, Replies, Reply %, Positive %,
-- Bounce %, Positive, Negative, Neutral, Meetings". REQ's screenshot shows the
-- same nine. We rendered five, with Positive/Negative/Neutral/Meetings missing —
-- so the table could show a positive RATE but never the count behind it, and a
-- 0.7% rate over 23,428 sends reads very differently once you know it is 152
-- people.
--
-- REQ page 1 also asks to "aggregate positive-rate by client/brand" for offers.
-- analytics_offer_rows already accepts a client filter but returned no client
-- dimension, so offers could be filtered by client and never grouped by one.
--
-- Meetings comes from outcome_events, counting the stages that ARE a meeting —
-- phone screens and interviews, scheduled or held. Attributed outcomes only,
-- for the same reason as 031: an outcome that cannot be traced to a campaign
-- cannot be traced to that campaign's copy either.

BEGIN;

DROP FUNCTION IF EXISTS analytics_copy_steps(BIGINT, DATE, DATE, UUID[], BIGINT[]);

CREATE FUNCTION analytics_copy_steps(
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
  -- New: the raw counts behind the rates (WT §6.1).
  negative         BIGINT,
  neutral          BIGINT,
  meetings         BIGINT,
  tags             JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT c.id, c.name, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  step_stats AS (
    SELECT s.sequence_step_id, s.campaign_id,
           SUM(s.sent)            AS sent,
           SUM(s.unique_replies)  AS replies,
           SUM(s.interested)      AS positive,
           SUM(s.bounced)         AS bounced
    FROM campaign_step_stats_daily s
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      AND s.campaign_id IN (SELECT id FROM scoped)
    GROUP BY s.sequence_step_id, s.campaign_id
  ),
  /*
   * Sentiment is per REPLY, not per step-day, so it is counted from `replies`
   * and joined on the step. A reply with no sentiment set counts as neither
   * negative nor neutral — it is unclassified, which is not the same as neutral
   * and must not be folded into it.
   */
  reply_sentiment AS (
    SELECT r.campaign_id,
           COUNT(*) FILTER (WHERE r.sentiment = 'negative') AS negative,
           COUNT(*) FILTER (WHERE r.sentiment = 'neutral')  AS neutral
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  campaign_meetings AS (
    SELECT o.resolved_campaign_id AS campaign_id, COUNT(*) AS meetings
    FROM outcome_events o
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND o.event_type IN ('phone_screen','phone_screen_scheduled','interview','interview_scheduled')
      AND o.resolved_campaign_id IN (SELECT id FROM scoped)
    GROUP BY o.resolved_campaign_id
  )
  SELECT
    st.id, sc.id, sc.name,
    co.offer_id,
    st.email_subject,
    COALESCE(ss.sent, 0)::BIGINT,
    COALESCE(ss.replies, 0)::BIGINT,
    COALESCE(ss.positive, 0)::BIGINT,
    COALESCE(ss.bounced, 0)::BIGINT,
    -- Campaign-level, repeated on each of its steps: sentiment and outcomes are
    -- not attributable to an individual email in the sequence. Grouping the
    -- table by a dimension sums these per group, which is the level the numbers
    -- are actually true at.
    COALESCE(rs.negative, 0)::BIGINT,
    COALESCE(rs.neutral, 0)::BIGINT,
    COALESCE(cm.meetings, 0)::BIGINT,
    COALESCE(ct.dimensions, '{}'::jsonb)
  FROM sequence_steps st
  JOIN scoped sc                ON sc.id = st.campaign_id
  LEFT JOIN step_stats ss       ON ss.sequence_step_id = st.id
  -- copy_tags is long (one row per dimension), so it is folded into a single
  -- object per step here rather than multiplying the step rows.
  LEFT JOIN LATERAL (
    SELECT jsonb_object_agg(t.dimension, t.value) AS dimensions
    FROM copy_tags t WHERE t.sequence_step_id = st.id
  ) ct ON TRUE
  LEFT JOIN campaign_offers co  ON co.campaign_id = sc.id
  LEFT JOIN reply_sentiment rs  ON rs.campaign_id = sc.id
  LEFT JOIN campaign_meetings cm ON cm.campaign_id = sc.id
  WHERE st.team_id = p_team_id
    -- First step only. Later steps inherit the first's framing, so mixing them
    -- in makes every dimension look the same.
    AND st.step_order = 1
    AND NOT st.is_variant;
$$;

/** Offers, with the client dimension REQ page 1 asks to aggregate by. */
DROP FUNCTION IF EXISTS analytics_offer_rows(BIGINT, DATE, DATE, UUID[]);

CREATE FUNCTION analytics_offer_rows(
  p_team_id    BIGINT,
  p_from       DATE,
  p_to         DATE,
  p_client_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  offer_id      UUID,
  offer_name    TEXT,
  niche         TEXT,
  campaigns     BIGINT,
  sent          BIGINT,
  replies       BIGINT,
  positive      BIGINT,
  bounced       BIGINT,
  reply_rate    NUMERIC,
  positive_rate NUMERIC,
  bounce_rate   NUMERIC,
  -- New: which clients run this offer, so it can be rolled up by client/brand.
  clients       JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT c.id, cc.client_id, cl.name AS client_name
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    LEFT JOIN clients cl     ON cl.id = cc.client_id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  per_campaign AS (
    SELECT co.offer_id, sc.id AS campaign_id, sc.client_name,
           COALESCE(SUM(s.sent), 0)           AS sent,
           COALESCE(SUM(s.unique_replies), 0) AS replies,
           COALESCE(SUM(s.interested), 0)     AS positive,
           COALESCE(SUM(s.bounced), 0)        AS bounced
    FROM campaign_offers co
    JOIN scoped sc ON sc.id = co.campaign_id
    LEFT JOIN campaign_step_stats_daily s
           ON s.campaign_id = sc.id AND s.stat_date BETWEEN p_from AND p_to
    GROUP BY co.offer_id, sc.id, sc.client_name
  )
  SELECT
    o.id, o.name, o.niche,
    COUNT(pc.campaign_id)::BIGINT,
    COALESCE(SUM(pc.sent), 0)::BIGINT,
    COALESCE(SUM(pc.replies), 0)::BIGINT,
    COALESCE(SUM(pc.positive), 0)::BIGINT,
    COALESCE(SUM(pc.bounced), 0)::BIGINT,
    -- NULLIF so a zero denominator returns NULL, which renders as a dash rather
    -- than a confident 0.0%.
    SUM(pc.replies)::NUMERIC  / NULLIF(SUM(pc.sent), 0),
    SUM(pc.positive)::NUMERIC / NULLIF(SUM(pc.replies), 0),
    SUM(pc.bounced)::NUMERIC  / NULLIF(SUM(pc.sent), 0),
    COALESCE(
      (SELECT jsonb_agg(x ORDER BY x->>'sent' DESC)
         FROM (
           SELECT jsonb_build_object(
                    'client',   COALESCE(p2.client_name, 'Unassigned'),
                    'campaigns', COUNT(*),
                    'sent',      SUM(p2.sent),
                    'replies',   SUM(p2.replies),
                    'positive',  SUM(p2.positive)
                  ) AS x
           FROM per_campaign p2
           WHERE p2.offer_id = o.id
           GROUP BY COALESCE(p2.client_name, 'Unassigned')
         ) t),
      '[]'::jsonb
    )
  FROM offers o
  LEFT JOIN per_campaign pc ON pc.offer_id = o.id
  WHERE o.team_id = p_team_id
  GROUP BY o.id, o.name, o.niche
  ORDER BY COALESCE(SUM(pc.sent), 0) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('032_copy_offer_columns')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
