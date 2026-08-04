-- 034 — surface hand-logged outcomes on the reply they came from.
--
-- §7: "Outcomes reach the system two ways: logged by hand from a reply, or fed
-- in automatically." /api/outcomes adds the first half; this lets the reply list
-- show what has already been logged, so the control reflects reality instead of
-- inviting a second click that silently no-ops (the id is idempotent) or, worse,
-- looks like it did nothing.

BEGIN;

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
  -- Outcome types already logged BY HAND against this reply, so the control
  -- can show what exists rather than letting an operator log a hire twice and
  -- only find out when the funnel disagrees with itself.
  logged         JSONB,
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
    COALESCE(
      (SELECT jsonb_agg(oe.event_type ORDER BY oe.event_type)
         FROM outcome_events oe
        WHERE oe.team_id = p_team_id
          AND NOT oe.voided
          -- The id scheme from /api/outcomes. Prefix-matched so the feed's own
          -- UUID rows can never be mistaken for hand-logged ones.
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

INSERT INTO schema_migrations (version) VALUES ('034_reply_logged_outcomes')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
