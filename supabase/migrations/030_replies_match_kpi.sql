-- 030 — make the Replies view count the same replies as the KPI band.
--
-- Caught by reading the rendered page rather than the code: the 90-day band said
-- 3.9K replies while the Replies view said 8,015 for the same range, and the top
-- two rows of the reply list were "Mail Delivery Subsystem — Delivery Status
-- Notification (Failure)".
--
-- `analytics_kpis` has always applied two filters that 027/028 did not:
--
--   AND NOT r.is_bounce_notification   -- a bounce is not a reply
--   AND r.campaign_id IN (scoped)      -- where scoped excludes cc.excluded,
--                                      -- i.e. the internal / test campaigns
--
-- This is exactly the failure CLAUDE.md rule 3 exists to prevent: one metric
-- family, one authority. Two numbers claiming to be "replies in this range",
-- differing by 2x, on the same screen, is worse than either being wrong on its
-- own — it makes both untrustworthy and gives no way to tell which to believe.
--
-- ALSO FIXED: each card reported the sum of the twelve rows it displays as its
-- own total, so a dimension with a long tail under-reported itself. The cards
-- read 6,378 / 3,358 / 3,630 / 8,015 for the same population. The true total is
-- now computed across ALL groups before the limit and returned separately, so a
-- card can say "12 of 340 shown" honestly instead of quietly redefining its
-- denominator.

BEGIN;

-- Dropped, not replaced: the OUT parameters gain grand_total/group_count, and
-- Postgres refuses to change a function's row type in place.
DROP FUNCTION IF EXISTS analytics_reply_breakdown(BIGINT, DATE, DATE, TEXT, UUID[], BIGINT[], BOOLEAN, INT);
CREATE FUNCTION analytics_reply_breakdown(
  p_team_id       BIGINT,
  p_from          DATE,
  p_to            DATE,
  p_dimension     TEXT,
  p_client_ids    UUID[]   DEFAULT NULL,
  p_campaign_ids  BIGINT[] DEFAULT NULL,
  p_positive_only BOOLEAN  DEFAULT FALSE,
  p_limit         INT      DEFAULT 12
)
RETURNS TABLE (
  value       TEXT,
  replies     BIGINT,
  positive    BIGINT,
  sort_order  INT,
  -- Across every group, not just the ones returned.
  grand_total BIGINT,
  group_count BIGINT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM reply_dimensions
   WHERE team_id = p_team_id AND key = p_dimension AND active
   ORDER BY client_id NULLS LAST LIMIT 1;

  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT r.id, r.lead_id, r.interested, cl.name AS client_name
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      -- Same two conditions analytics_kpis applies. Without them this view and
      -- the band above it disagree about what a reply is.
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR r.interested)
  ),
  labelled AS (
    SELECT
      s.interested,
      reply_dimension_value(
        d.source, d.bucket, s.client_name, l.company, la.value, la.value_numeric
      ) AS val,
      CASE WHEN d.bucket = 'currency_bands'
           THEN currency_band_order(la.value_numeric) ELSE 0 END AS ord
    FROM scoped s
    LEFT JOIN leads l ON d.source = 'lead_field' AND l.id = s.lead_id
    LEFT JOIN lead_attributes la
           ON d.source = 'lead_attribute' AND la.lead_id = s.lead_id AND la.name = d.source_key
  ),
  grouped AS (
    SELECT lb.val, COUNT(*) AS n, COUNT(*) FILTER (WHERE lb.interested) AS pos, MIN(lb.ord)::INT AS ord
    FROM labelled lb GROUP BY lb.val
  )
  SELECT
    g.val, g.n, g.pos, g.ord,
    SUM(g.n)   OVER ()::BIGINT,
    COUNT(*)   OVER ()::BIGINT
  FROM grouped g
  ORDER BY CASE WHEN d.bucket = 'currency_bands' THEN g.ord END, g.n DESC
  LIMIT p_limit;
END;
$$;

/** Same two conditions on the list, so a bar and its rows stay in step. */
CREATE OR REPLACE FUNCTION analytics_reply_rows(
  p_team_id       BIGINT,
  p_from          DATE,
  p_to            DATE,
  p_client_ids    UUID[]   DEFAULT NULL,
  p_campaign_ids  BIGINT[] DEFAULT NULL,
  p_positive_only BOOLEAN  DEFAULT FALSE,
  p_dimension     TEXT     DEFAULT NULL,
  p_value         TEXT     DEFAULT NULL,
  p_search        TEXT     DEFAULT NULL,
  p_limit         INT      DEFAULT 50,
  p_offset        INT      DEFAULT 0
)
RETURNS TABLE (
  id             BIGINT,
  date_received  TIMESTAMPTZ,
  from_name      TEXT,
  from_email     TEXT,
  subject        TEXT,
  preview        TEXT,
  interested     BOOLEAN,
  automated      BOOLEAN,
  campaign_id    BIGINT,
  campaign_name  TEXT,
  client_name    TEXT,
  lead_id        BIGINT,
  company        TEXT,
  office_city    TEXT,
  sales_volume   TEXT,
  total_count    BIGINT
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  IF p_dimension IS NOT NULL AND p_value IS NOT NULL THEN
    SELECT * INTO d FROM reply_dimensions
     WHERE team_id = p_team_id AND key = p_dimension AND active
     ORDER BY client_id NULLS LAST LIMIT 1;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    -- Cheap: only what the filters and the sort need. No text, no detail joins.
    -- Everything expensive happens after the LIMIT, on 50 rows.
    SELECT r.id, r.date_received
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    LEFT JOIN leads l             ON l.id  = r.lead_id
    LEFT JOIN lead_attributes dim ON d.source = 'lead_attribute'
                                 AND dim.lead_id = r.lead_id
                                 AND dim.name = d.source_key
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR r.interested)
      AND (
        p_search IS NULL
        OR r.from_email_address ILIKE '%' || p_search || '%'
        OR r.from_name          ILIKE '%' || p_search || '%'
        OR r.subject            ILIKE '%' || p_search || '%'
      )
      AND (
        p_value IS NULL
        OR reply_dimension_value(
             d.source, d.bucket, cl.name, l.company, dim.value, dim.value_numeric
           ) = p_value
      )
  ),
  page AS (
    SELECT s.id, s.date_received, COUNT(*) OVER () AS total
    FROM scoped s
    ORDER BY s.date_received DESC, s.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
    left(regexp_replace(COALESCE(r.text_body, ''), '\s+', ' ', 'g'), 180),
    r.interested, r.automated_reply, r.campaign_id, c.name, cl.name, r.lead_id,
    l.company, city.value, vol.value,
    pg.total
  FROM page pg
  JOIN replies r                 ON r.id = pg.id
  LEFT JOIN campaigns c          ON c.id = r.campaign_id
  LEFT JOIN campaign_clients cc  ON cc.campaign_id = r.campaign_id
  LEFT JOIN clients cl           ON cl.id = cc.client_id
  LEFT JOIN leads l              ON l.id  = r.lead_id
  LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
  LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
  ORDER BY r.date_received DESC, r.id;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('030_replies_match_kpi')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
