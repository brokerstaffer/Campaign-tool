-- 038 — apply the reply attribute filters to the charts and the list.
--
-- 037 supplies the values; this makes selecting one actually filter. Both the
-- breakdown and the row list take the same three arrays, so a filter set in the
-- bar narrows the bars and the replies underneath them identically — the same
-- reason both already resolve a bucket through reply_dimension_value.
--
-- NULL means "no filter", not "match nothing": an absent filter must not empty
-- the page.

BEGIN;

DROP FUNCTION IF EXISTS analytics_reply_breakdown(BIGINT, DATE, DATE, TEXT, UUID[], BIGINT[], BOOLEAN, INT);

CREATE FUNCTION analytics_reply_breakdown(
  p_team_id       BIGINT,
  p_from          DATE,
  p_to            DATE,
  p_dimension     TEXT,
  p_client_ids    UUID[]   DEFAULT NULL,
  p_campaign_ids  BIGINT[] DEFAULT NULL,
  p_positive_only BOOLEAN  DEFAULT FALSE,
  p_limit         INT      DEFAULT 12,
  p_company       TEXT[]   DEFAULT NULL,
  p_location      TEXT[]   DEFAULT NULL,
  p_sales_volume  TEXT[]   DEFAULT NULL
)
RETURNS TABLE (
  value       TEXT,
  replies     BIGINT,
  positive    BIGINT,
  sort_order  INT,
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
    LEFT JOIN leads l             ON l.id = r.lead_id
    LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
    LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR r.campaign_id = ANY(p_campaign_ids))
      AND (NOT p_positive_only OR r.interested)
      AND (p_company      IS NULL OR COALESCE(NULLIF(l.company,''), 'Unknown') = ANY(p_company))
      AND (p_location     IS NULL OR COALESCE(NULLIF(city.value,''), 'Unknown') = ANY(p_location))
      AND (p_sales_volume IS NULL OR currency_band_label(vol.value_numeric) = ANY(p_sales_volume))
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
  SELECT g.val, g.n, g.pos, g.ord,
         SUM(g.n) OVER ()::BIGINT,
         COUNT(*) OVER ()::BIGINT
  FROM grouped g
  ORDER BY CASE WHEN d.bucket = 'currency_bands' THEN g.ord END, g.n DESC
  LIMIT p_limit;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('038_reply_facet_filters')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
