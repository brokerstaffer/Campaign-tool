-- 012_analytics_clients.sql — the Clients sub-view.
--
-- Same metric set as the KPI band, grouped by client. Client is a GROUP BY,
-- never a different derivation: if a client row computed Reply Rate differently
-- from the tile above it, the two would disagree and nobody would know which to
-- believe.
--
-- The Unassigned row is emitted as a real row (client_id IS NULL), not filtered
-- out. If unmatched campaigns were dropped, SUM(clients) would silently fall
-- short of the KPI band by however much volume they carry.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_client_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  client_id      UUID,
  client_name    TEXT,
  campaign_count BIGINT,
  ambiguous_count BIGINT,
  sent           BIGINT,
  prospects      BIGINT,
  replies        BIGINT,
  human_replies  BIGINT,
  positive       BIGINT,
  bounces        BIGINT,
  median_reply_seconds NUMERIC
)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT c.id AS campaign_id, cc.client_id, cc.ambiguous
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  sent_by AS (
    SELECT s.campaign_id, SUM(s.value) FILTER (WHERE s.metric = 'sent')    AS sent,
                          SUM(s.value) FILTER (WHERE s.metric = 'bounces') AS bounces
    FROM eb_daily_series s
    WHERE s.team_id = p_team_id AND s.campaign_id <> 0
      AND s.stat_date BETWEEN p_from AND p_to
      AND s.campaign_id IN (SELECT campaign_id FROM scoped)
    GROUP BY s.campaign_id
  ),
  prospects_by AS (
    SELECT d.campaign_id, SUM(d.total_leads_contacted) AS prospects
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id
      AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT campaign_id FROM scoped)
    GROUP BY d.campaign_id
  ),
  replies_by AS (
    SELECT r.campaign_id,
           COUNT(*)                                      AS replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply)  AS human,
           COUNT(*) FILTER (WHERE r.interested)           AS positive,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
           ) FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at) AS median_reply
    FROM replies r
    WHERE r.team_id = p_team_id AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT campaign_id FROM scoped)
    GROUP BY r.campaign_id
  )
  SELECT
    sc.client_id,
    COALESCE(cl.name, 'Unassigned'),
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE sc.ambiguous)::BIGINT,
    COALESCE(SUM(sb.sent), 0)::BIGINT,
    COALESCE(SUM(pb.prospects), 0)::BIGINT,
    COALESCE(SUM(rb.replies), 0)::BIGINT,
    COALESCE(SUM(rb.human), 0)::BIGINT,
    COALESCE(SUM(rb.positive), 0)::BIGINT,
    COALESCE(SUM(sb.bounces), 0)::BIGINT,
    -- Median of per-campaign medians. An approximation, and labelled as such in
    -- the UI: a true median needs the underlying population, which would mean
    -- a second pass over every reply per client.
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY rb.median_reply)
  FROM scoped sc
  LEFT JOIN clients cl        ON cl.id = sc.client_id
  LEFT JOIN sent_by sb        ON sb.campaign_id = sc.campaign_id
  LEFT JOIN prospects_by pb   ON pb.campaign_id = sc.campaign_id
  LEFT JOIN replies_by rb     ON rb.campaign_id = sc.campaign_id
  GROUP BY sc.client_id, cl.name
  -- Clients with no activity in the window are dropped: 14 of 39 clients have
  -- no campaigns at all, and listing them as permanent zero rows would bury
  -- the ones that matter.
  HAVING COALESCE(SUM(sb.sent), 0) > 0 OR COALESCE(SUM(rb.replies), 0) > 0
  ORDER BY 5 DESC;
$$;

NOTIFY pgrst, 'reload schema';

INSERT INTO schema_migrations (version) VALUES ('012_analytics_clients')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
