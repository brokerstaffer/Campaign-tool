-- 039 — the reply LIST honours the same attribute filters as the charts.
--
-- 038 filtered the bars. Without this the list underneath them ignored the
-- filter, so selecting "Compass" narrowed every chart to 153 replies while the
-- rows below still showed all 3,937 — the two halves of one screen describing
-- different populations, which is the failure 030 already fixed once between
-- this view and the KPI band.

BEGIN;

DROP FUNCTION IF EXISTS analytics_reply_rows(BIGINT, DATE, DATE, UUID[], BIGINT[], BOOLEAN, TEXT, TEXT, TEXT, INT, INT);

CREATE FUNCTION analytics_reply_rows(
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
  p_offset        INT      DEFAULT 0,
  p_company       TEXT[]   DEFAULT NULL,
  p_location      TEXT[]   DEFAULT NULL,
  p_sales_volume  TEXT[]   DEFAULT NULL
)
RETURNS TABLE (
  id BIGINT, date_received TIMESTAMPTZ, from_name TEXT, from_email TEXT,
  subject TEXT, preview TEXT, interested BOOLEAN, automated BOOLEAN,
  campaign_id BIGINT, campaign_name TEXT, client_name TEXT, lead_id BIGINT,
  company TEXT, office_city TEXT, sales_volume TEXT, logged JSONB,
  total_count BIGINT
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
    SELECT r.id, r.date_received
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    LEFT JOIN leads l             ON l.id  = r.lead_id
    LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
    LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
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
      AND (p_company      IS NULL OR COALESCE(NULLIF(l.company,''), 'Unknown') = ANY(p_company))
      AND (p_location     IS NULL OR COALESCE(NULLIF(city.value,''), 'Unknown') = ANY(p_location))
      AND (p_sales_volume IS NULL OR currency_band_label(vol.value_numeric) = ANY(p_sales_volume))
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
    FROM scoped s ORDER BY s.date_received DESC, s.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
    left(regexp_replace(COALESCE(r.text_body, ''), '\s+', ' ', 'g'), 180),
    r.interested, r.automated_reply, r.campaign_id, c.name, cl.name, r.lead_id,
    l.company, city.value, vol.value,
    COALESCE(
      (SELECT jsonb_agg(oe.event_type ORDER BY oe.event_type)
         FROM outcome_events oe
        WHERE oe.team_id = p_team_id AND NOT oe.voided
          AND oe.id = 'manual:' || r.id || ':' || oe.event_type),
      '[]'::jsonb
    ),
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

INSERT INTO schema_migrations (version) VALUES ('039_reply_rows_facets')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
