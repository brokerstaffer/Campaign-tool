-- 028 — the individual replies underneath the breakdown cards (spec §5.5).
--
-- "Underneath, the individual replies themselves, filterable by the same
-- attributes."
--
-- Paged in SQL, like every other list here: PostgREST caps a .select() at 1000
-- rows and truncates SILENTLY, and this list is over a table with ~8,000 rows
-- growing daily (CLAUDE.md rule 7). `total_count` rides along on every row so
-- the header states a counted number rather than inferring one from page size.

BEGIN;

/**
 * Resolves one reply's value for a dimension.
 *
 * Kept as its own function so the breakdown chart and the list below it can
 * never disagree about what bucket a reply belongs to — clicking a bar must
 * select exactly the rows that bar counted.
 */
CREATE OR REPLACE FUNCTION reply_dimension_value(
  p_dimension_source TEXT,
  p_bucket           TEXT,
  p_client_name      TEXT,
  p_company          TEXT,
  p_attr_value       TEXT,
  p_attr_numeric     NUMERIC
)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_dimension_source
    WHEN 'client'     THEN COALESCE(p_client_name, 'Unassigned')
    WHEN 'lead_field' THEN COALESCE(NULLIF(p_company, ''), 'Unknown')
    ELSE CASE
      WHEN p_bucket = 'currency_bands' THEN currency_band_label(p_attr_numeric)
      ELSE COALESCE(NULLIF(p_attr_value, ''), 'Unknown')
    END
  END;
$$;

CREATE OR REPLACE FUNCTION analytics_reply_rows(
  p_team_id       BIGINT,
  p_from          DATE,
  p_to            DATE,
  p_client_ids    UUID[]   DEFAULT NULL,
  p_campaign_ids  BIGINT[] DEFAULT NULL,
  p_positive_only BOOLEAN  DEFAULT FALSE,
  -- Optional drill-down: "the replies behind this bar".
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
  IF p_dimension IS NOT NULL THEN
    SELECT * INTO d FROM reply_dimensions
     WHERE team_id = p_team_id AND key = p_dimension AND active
     ORDER BY client_id NULLS LAST LIMIT 1;
  END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT
      r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
      r.text_body, r.interested, r.automated_reply, r.campaign_id, r.lead_id,
      c.name  AS campaign_name,
      cl.name AS client_name,
      l.company,
      city.value          AS office_city,
      vol.value           AS sales_volume_raw,
      vol.value_numeric   AS sales_volume_numeric
    FROM replies r
    LEFT JOIN campaigns c         ON c.id  = r.campaign_id
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    LEFT JOIN leads l             ON l.id  = r.lead_id
    LEFT JOIN lead_attributes city ON city.lead_id = r.lead_id AND city.name = 'office city'
    LEFT JOIN lead_attributes vol  ON vol.lead_id  = r.lead_id AND vol.name  = 'sales volume'
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
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
  ),
  filtered AS (
    SELECT s.* FROM scoped s
    WHERE p_dimension IS NULL OR p_value IS NULL
       OR reply_dimension_value(
            d.source, d.bucket, s.client_name, s.company,
            CASE d.source_key
              WHEN 'office city'  THEN s.office_city
              WHEN 'sales volume' THEN s.sales_volume_raw
              ELSE (SELECT la.value FROM lead_attributes la
                     WHERE la.lead_id = s.lead_id AND la.name = d.source_key)
            END,
            CASE d.source_key
              WHEN 'sales volume' THEN s.sales_volume_numeric
              ELSE (SELECT la.value_numeric FROM lead_attributes la
                     WHERE la.lead_id = s.lead_id AND la.name = d.source_key)
            END
          ) = p_value
  )
  SELECT
    f.id, f.date_received, f.from_name, f.from_email_address, f.subject,
    -- Enough to recognise the reply, not enough to render an inbox.
    left(regexp_replace(COALESCE(f.text_body, ''), '\s+', ' ', 'g'), 180),
    f.interested, f.automated_reply, f.campaign_id, f.campaign_name,
    f.client_name, f.lead_id, f.company, f.office_city, f.sales_volume_raw,
    COUNT(*) OVER ()
  FROM filtered f
  ORDER BY f.date_received DESC, f.id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('028_reply_rows')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
