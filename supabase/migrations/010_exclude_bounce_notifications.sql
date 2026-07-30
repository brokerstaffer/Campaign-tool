-- 010_exclude_bounce_notifications.sql
--
-- BUG FIX: delivery-status notifications were being counted as replies.
--
-- GET /api/campaigns/{id}/replies returns mailer daemon bounce-backs alongside
-- genuine replies. Of 7,496 tracked rows, 3,893 were "Delivery Status
-- Notification (Failure/Delay)" or "Undeliverable: ...". Counting those as
-- replies inflated Replies by 2x and halved... no, DOUBLED... the Reply Rate:
-- ~4.6% instead of ~2.2%. Wrong, and wrong in the flattering direction.
--
-- They are also already counted in Bounces, so including them here meant the
-- same physical event was reported in two different KPI tiles.
--
-- Evidence this is the right call: excluding them gives 3,603 replies and
-- 3,386 human replies, against the reference product's 3,679 and ~3,5xx --
-- within 2%. Three metrics now reconcile independently against the reference.
--
-- Implemented as a GENERATED column so the rule lives in one place and applies
-- to rows already stored, rather than being a WHERE clause every query has to
-- remember to repeat.

BEGIN;

ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS is_bounce_notification BOOLEAN
    GENERATED ALWAYS AS (
      subject ILIKE 'Delivery Status Notification%'
      OR subject ILIKE 'Undeliverable:%'
      OR subject ILIKE 'Mail delivery failed%'
      OR subject ILIKE 'Returned mail%'
      OR subject ILIKE 'Delivery has failed%'
      OR subject ILIKE 'failure notice%'
    ) STORED;

-- Every reply metric reads through this predicate.
CREATE INDEX IF NOT EXISTS idx_replies_genuine
  ON replies (team_id, received_date, campaign_id)
  WHERE tracked_reply AND NOT is_bounce_notification;

COMMENT ON COLUMN replies.is_bounce_notification IS
  'Mailer-daemon bounce-back, not a reply. Excluded from Replies/Human/Positive '
  '- the same event is already counted in Bounces.';

-- Rebuild analytics_kpis with the exclusion applied.
CREATE OR REPLACE FUNCTION analytics_kpis(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_compare      BOOLEAN  DEFAULT FALSE
)
RETURNS TABLE (
  period        TEXT,
  range_from    DATE,
  range_to      DATE,
  sent          BIGINT,
  prospects     BIGINT,
  replies       BIGINT,
  human_replies BIGINT,
  positive      BIGINT,
  bounces       BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH periods AS (
    SELECT 'current'::TEXT AS period, p_from AS f, p_to AS t
    UNION ALL
    SELECT 'previous', p_from - (p_to - p_from + 1), p_from - 1
    WHERE p_compare
  ),
  scoped AS (
    SELECT c.id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  -- One CTE so Replies / Human / Positive can never drift apart: they are three
  -- filters over one population, not three separate queries.
  reply_counts AS (
    SELECT pr.period,
           COUNT(*)                                   AS all_replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply) AS human,
           COUNT(*) FILTER (WHERE r.interested)          AS positive
    FROM periods pr
    LEFT JOIN replies r
      ON r.team_id = p_team_id
     AND r.tracked_reply
     AND NOT r.is_bounce_notification
     AND r.campaign_id IN (SELECT id FROM scoped)
     AND r.received_date BETWEEN pr.f AND pr.t
    GROUP BY pr.period
  )
  SELECT
    pr.period, pr.f, pr.t,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'sent'
                AND s.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    COALESCE((SELECT SUM(d.total_leads_contacted) FROM campaign_day_stats d
              WHERE d.team_id = p_team_id
                AND d.campaign_id IN (SELECT id FROM scoped)
                AND d.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT,
    COALESCE(rc.all_replies, 0)::BIGINT,
    COALESCE(rc.human, 0)::BIGINT,
    COALESCE(rc.positive, 0)::BIGINT,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'bounces'
                AND s.stat_date BETWEEN pr.f AND pr.t), 0)::BIGINT
  FROM periods pr
  LEFT JOIN reply_counts rc ON rc.period = pr.period;
$$;

NOTIFY pgrst, 'reload schema';

INSERT INTO schema_migrations (version) VALUES ('010_exclude_bounce_notifications')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
