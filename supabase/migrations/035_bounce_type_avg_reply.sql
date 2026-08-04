-- 035 — soft/hard bounces (M3) and average reply time (M4).
--
-- REQ page 2 lists both: "Bounces (soft/hard) ... Reply Time, Average Reply
-- Time". Neither existed.
--
-- EMAILBISON HAS NO SOFT/HARD FIELD. Checked: campaign stats expose `bounced`
-- and `bounced_percentage` only, the daily series has one `Bounced` label, and a
-- bounced reply's `type` is just "Bounced". So the split has to be derived from
-- the notification itself, and the notifications turn out to be a near-complete
-- census: 4,133 stored bounce notifications against 4,141 bounces EmailBison
-- reports for the same period — 99.8%.
--
-- They classify cleanly, because bounce notifications are machine-generated and
-- their subjects are boilerplate:
--
--   Delivery Status Notification (Failure)          3,417   hard
--   Delivery Status Notification (Delay)              605   soft
--   Undeliverable: <original subject>                ~100   hard
--   Mail delivery failed: returning message...          3   hard
--
-- WHICH SURFACES SOMETHING WORTH KNOWING: 605 of 4,133 (14.6%) are DELAYS —
-- temporary retries, not failures — and EmailBison counts them as bounces. The
-- headline bounce rate is therefore ~15% higher than the rate of mail that
-- actually failed to deliver. That is the difference between a domain being in
-- trouble and a receiving server being briefly slow.
--
-- THE SPLIT DOES NOT REPLACE THE BOUNCES KPI. That still comes from
-- eb_daily_series (CLAUDE.md rule 3: one authority per metric family). This is a
-- BREAKDOWN of the notifications we can classify, and hard+soft will not sum to
-- the KPI exactly — 8 bounces in the current window produced no notification we
-- stored. Naming the columns after the classification rather than after
-- "bounces" keeps that honest.

BEGIN;

/**
 * Classifies a bounce notification from its subject.
 *
 * Boilerplate matching, deliberately conservative: anything unrecognised is
 * 'unknown' rather than being defaulted to 'hard'. Guessing hard would inflate
 * the number people act on — a hard bounce means suppress the address.
 */
CREATE OR REPLACE FUNCTION bounce_type(p_subject TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_subject IS NULL THEN 'unknown'
    -- Delay first: "Delivery Status Notification (Delay)" also contains the
    -- word Delivery, so a hard-pattern check ahead of this would swallow it.
    WHEN p_subject ILIKE '%(Delay)%'
      OR p_subject ILIKE '%delayed%'
      OR p_subject ILIKE '%temporar%'          THEN 'soft'
    WHEN p_subject ILIKE '%(Failure)%'
      OR p_subject ILIKE 'Undeliverable%'
      OR p_subject ILIKE '%delivery failed%'
      OR p_subject ILIKE '%returning message to sender%'
      OR p_subject ILIKE '%could not be delivered%'
      OR p_subject ILIKE '%address not found%'  THEN 'hard'
    ELSE 'unknown'
  END;
$$;

DROP FUNCTION IF EXISTS analytics_campaign_rows(BIGINT, DATE, DATE, BIGINT[], UUID[]);

CREATE FUNCTION analytics_campaign_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  campaign_id          BIGINT,
  campaign_name        TEXT,
  status               TEXT,
  client_name          TEXT,
  step_count           BIGINT,
  sent                 BIGINT,
  prospects            BIGINT,
  replies              BIGINT,
  human_replies        BIGINT,
  positive             BIGINT,
  negative             BIGINT,
  neutral              BIGINT,
  bot_replies          BIGINT,
  bounces              BIGINT,
  median_reply_seconds NUMERIC,
  -- M4: the mean beside the median. Both, because they answer different
  -- questions — the median is the typical prospect, the mean is dragged by the
  -- one who replied three weeks later, and a large gap between them IS the
  -- finding.
  avg_reply_seconds    NUMERIC,
  -- M3: derived from the bounce notification, not from EmailBison.
  bounces_hard         BIGINT,
  bounces_soft         BIGINT,
  introductions        BIGINT,
  phone_screens        BIGINT,
  interviews           BIGINT,
  hires                BIGINT,
  outcomes_total       BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT c.id, c.name, c.status, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  series AS (
    SELECT s.campaign_id,
           SUM(s.value) FILTER (WHERE s.metric = 'sent')    AS sent,
           SUM(s.value) FILTER (WHERE s.metric = 'bounces') AS bounces
    FROM eb_daily_series s
    WHERE s.team_id = p_team_id AND s.campaign_id <> 0
      AND s.stat_date BETWEEN p_from AND p_to
      AND s.campaign_id IN (SELECT id FROM scoped)
    GROUP BY s.campaign_id
  ),
  day_stats AS (
    SELECT d.campaign_id, SUM(d.total_leads_contacted) AS prospects
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY d.campaign_id
  ),
  reply_stats AS (
    SELECT r.campaign_id,
           COUNT(*)                                            AS replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply)       AS human,
           COUNT(*) FILTER (WHERE r.interested)                AS positive,
           COUNT(*) FILTER (WHERE r.sentiment = 'negative')    AS negative,
           COUNT(*) FILTER (WHERE r.sentiment = 'neutral')     AS neutral,
           COUNT(*) FILTER (WHERE r.automated_reply)           AS bots,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
           ) FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS median_reply,
           AVG(EXTRACT(EPOCH FROM (r.date_received - r.first_send_at)))
             FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS avg_reply
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  bounce_split AS (
    SELECT r.campaign_id,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'hard') AS hard,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'soft') AS soft
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  outcomes AS (
    SELECT o.resolved_campaign_id AS campaign_id,
           COUNT(*) FILTER (WHERE o.event_type = 'introduction') AS introductions,
           COUNT(*) FILTER (WHERE o.event_type IN ('phone_screen','phone_screen_scheduled')) AS phone_screens,
           COUNT(*) FILTER (WHERE o.event_type IN ('interview','interview_scheduled')) AS interviews,
           COUNT(*) FILTER (WHERE o.event_type = 'hired') AS hires,
           COUNT(*) AS total
    FROM outcome_events o
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND o.resolved_campaign_id IN (SELECT id FROM scoped)
    GROUP BY o.resolved_campaign_id
  )
  SELECT
    sc.id, sc.name, sc.status, cl.name,
    (SELECT COUNT(*) FROM sequence_steps st WHERE st.campaign_id = sc.id)::BIGINT,
    COALESCE(se.sent, 0)::BIGINT,
    COALESCE(ds.prospects, 0)::BIGINT,
    COALESCE(rs.replies, 0)::BIGINT,
    COALESCE(rs.human, 0)::BIGINT,
    COALESCE(rs.positive, 0)::BIGINT,
    COALESCE(rs.negative, 0)::BIGINT,
    COALESCE(rs.neutral, 0)::BIGINT,
    COALESCE(rs.bots, 0)::BIGINT,
    COALESCE(se.bounces, 0)::BIGINT,
    rs.median_reply,
    rs.avg_reply,
    COALESCE(bs.hard, 0)::BIGINT,
    COALESCE(bs.soft, 0)::BIGINT,
    COALESCE(oc.introductions, 0)::BIGINT,
    COALESCE(oc.phone_screens, 0)::BIGINT,
    COALESCE(oc.interviews, 0)::BIGINT,
    COALESCE(oc.hires, 0)::BIGINT,
    COALESCE(oc.total, 0)::BIGINT
  FROM scoped sc
  LEFT JOIN clients cl     ON cl.id = sc.client_id
  LEFT JOIN series se      ON se.campaign_id = sc.id
  LEFT JOIN day_stats ds   ON ds.campaign_id = sc.id
  LEFT JOIN reply_stats rs ON rs.campaign_id = sc.id
  LEFT JOIN bounce_split bs ON bs.campaign_id = sc.id
  LEFT JOIN outcomes oc    ON oc.campaign_id = sc.id
  ORDER BY COALESCE(se.sent, 0) DESC;
$$;

-- The classifier scans bounce notifications by campaign and date.
CREATE INDEX IF NOT EXISTS idx_replies_bounces
  ON replies (team_id, campaign_id, received_date) WHERE is_bounce_notification;

INSERT INTO schema_migrations (version) VALUES ('035_bounce_type_avg_reply')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
