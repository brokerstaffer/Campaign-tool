-- 029 — make the reply list fast. Measured at every step, because the first two
-- diagnoses were both wrong.
--
-- Baseline: 1,190ms for a 50-row page over 6,076 replies.
--
--  ATTEMPT 1 — the drill-down was paid for even when unused. 028 resolved the
--    selected dimension with correlated subqueries inside a WHERE that also
--    said "or no dimension is selected", and Postgres is not obliged to
--    short-circuit an OR. Replacing them with a LEFT JOIN took the DRILL-DOWN
--    paths to ~300ms and left the plain list at ~1,160ms. Real, but not it.
--
--  ATTEMPT 2 — the plan showed `temp read=1024` (spilling to disk), so the
--    theory was that COUNT(*) OVER () materialised 6,083 rows each carrying a
--    full email body. Truncating the preview earlier changed nothing: 1,304ms.
--    Also wrong.
--
--  THE ACTUAL CAUSE — it was never about carrying the body, it was about
--    TOUCHING it. `regexp_replace` over every matching row is the work, and it
--    ran 6,083 times to produce 50 previews. Moving it earlier just moved when.
--
-- So: pick the page first, decorate it second. The inner query sorts and limits
-- on indexed columns alone — no joins, no text — and the outer one joins detail
-- and builds previews for the 50 rows that survive. Everything expensive now
-- runs 50 times instead of 6,083.

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
    -- The window count runs over ids and timestamps only, so it no longer
    -- spills, and the LIMIT happens before any detail work.
    SELECT s.id, s.date_received, COUNT(*) OVER () AS total
    FROM scoped s
    ORDER BY s.date_received DESC, s.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
    -- 50 regexp calls, not 6,083.
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

-- The list orders by date within a team, which the rollup index does not serve.
CREATE INDEX IF NOT EXISTS idx_replies_recent
  ON replies (team_id, date_received DESC) WHERE tracked_reply;

INSERT INTO schema_migrations (version) VALUES ('029_reply_rows_faster')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
