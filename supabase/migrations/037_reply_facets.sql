-- 037 — the values behind the reply filters (REQ page 2).
--
-- "Filters: campaign, client, brokerage/office/brand, city/county,
--  sales-volume buckets, company"
--
-- Campaign and client were in the filter bar; the lead-attribute ones existed
-- only as click-a-bar inside the Replies tab, which cannot be shared as a link
-- or combined with a date range the way the others can.
--
-- This returns the distinct values per dimension so the filter controls can
-- offer real choices. Capped and ordered by frequency: "Current brokerage" has
-- 1,329 distinct values and a dropdown listing all of them is not a filter, it
-- is a phone book. The long tail is reachable by typing, which the multiselect
-- already supports.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_reply_facet_values(
  p_team_id   BIGINT,
  p_from      DATE,
  p_to        DATE,
  p_dimension TEXT,
  p_limit     INT DEFAULT 50
)
RETURNS TABLE (value TEXT, replies BIGINT)
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
    SELECT r.lead_id, cl.name AS client_name
    FROM replies r
    LEFT JOIN campaign_clients cc ON cc.campaign_id = r.campaign_id
    LEFT JOIN clients cl          ON cl.id = cc.client_id
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND COALESCE(cc.excluded, FALSE) = FALSE
      AND r.received_date BETWEEN p_from AND p_to
  )
  SELECT
    reply_dimension_value(
      d.source, d.bucket, s.client_name, l.company, la.value, la.value_numeric
    ) AS v,
    COUNT(*)
  FROM scoped s
  LEFT JOIN leads l ON d.source = 'lead_field' AND l.id = s.lead_id
  LEFT JOIN lead_attributes la
         ON d.source = 'lead_attribute' AND la.lead_id = s.lead_id AND la.name = d.source_key
  GROUP BY v
  -- Unknown is counted in the charts but is not a filter anyone wants to pick.
  HAVING reply_dimension_value(
           d.source, d.bucket, s.client_name, l.company, la.value, la.value_numeric
         ) NOT IN ('Unknown', 'Unassigned')
  ORDER BY COUNT(*) DESC
  LIMIT p_limit;
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('037_reply_facets')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
