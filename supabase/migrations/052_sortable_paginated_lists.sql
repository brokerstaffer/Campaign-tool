-- 052 — server-side sorting for the three lists that are paginated.
--
-- WHY THESE CANNOT BE SORTED IN THE BROWSER. The reply list, the outcome list
-- and the inbox list are paged in SQL — the client holds 50 rows out of
-- thousands. Sorting those 50 would reorder one page and look exactly like
-- sorting everything, which is worse than not offering it: the top of the list
-- would confidently claim to be the worst inbox in the estate when it is only
-- the worst of the fifty you happen to be looking at.
--
-- THE ORDER BY SHAPE. Four clauses — numeric ascending, numeric descending,
-- text ascending, text descending — then the table's own default. Postgres
-- needs the numeric and text cases separated because a single CASE must return
-- one type, and a duration compared as text sorts "38.6m" after "12.5h".
--
-- p_sort NULL means "no sort", which is the third click. Every clause collapses
-- to NULL and the default ORDER BY takes over, so resetting returns the exact
-- order the list was designed to show rather than an arbitrary one.
--
-- NULLS LAST in both directions, matching the client-side sorter: a dash means
-- no data, and floating those to the top of an ascending sort would present
-- them as the smallest values.
--
-- analytics_sender_groups had NO sort at all — Infrastructure's domain and
-- provider views were fixed to volume, and the inbox view's control was a
-- dropdown with three options rather than sortable headers.

BEGIN;

DROP FUNCTION IF EXISTS analytics_outcome_events(BIGINT, DATE, DATE, TEXT[], TEXT[], UUID[], TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS analytics_sender_rows(BIGINT, INTEGER, TEXT, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS analytics_sender_groups(BIGINT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS analytics_reply_rows(BIGINT, DATE, DATE, UUID[], BIGINT[], BOOLEAN, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT[], TEXT[], TEXT[]);

CREATE OR REPLACE FUNCTION public.analytics_outcome_events(p_team_id bigint, p_from date, p_to date, p_types text[] DEFAULT NULL::text[], p_platforms text[] DEFAULT NULL::text[], p_client_ids uuid[] DEFAULT NULL::uuid[], p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0, p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(id text, email text, event_type text, occurred_at timestamp with time zone, source_platform text, source_campaign_ref text, resolution text, campaign_id bigint, campaign_name text, client_name text, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH scoped AS (
    SELECT o.*
    FROM outcome_events o
    LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND (p_types     IS NULL OR o.event_type      = ANY(p_types))
      AND (p_platforms IS NULL OR o.source_platform = ANY(p_platforms))
      AND (p_client_ids IS NULL OR COALESCE(o.resolved_client_id, cc.client_id) = ANY(p_client_ids))
      AND (p_search    IS NULL OR o.email ILIKE '%' || p_search || '%')
  )
  SELECT
    s.id,
    s.email,
    s.event_type,
    s.occurred_at,
    s.source_platform,
    s.source_campaign_ref,
    -- NULL means the resolver has not looked yet; the UI must not render that
    -- the same as "looked and found nothing".
    COALESCE(s.resolution, 'pending'),
    s.resolved_campaign_id,
    c.name,
    cl.name,
    COUNT(*) OVER ()
  FROM scoped s
  LEFT JOIN campaigns c        ON c.id  = s.resolved_campaign_id
  LEFT JOIN campaign_clients m ON m.campaign_id = s.resolved_campaign_id
  LEFT JOIN clients cl         ON cl.id = COALESCE(s.resolved_client_id, m.client_id)
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'occurred_at' THEN (EXTRACT(EPOCH FROM s.occurred_at))::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'occurred_at' THEN (EXTRACT(EPOCH FROM s.occurred_at))::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(s.email, '')
      WHEN 'event_type' THEN NULLIF(s.event_type, '')
      WHEN 'source_platform' THEN NULLIF(s.source_platform, '')
      WHEN 'resolution' THEN (COALESCE(s.resolution,'pending'))
      WHEN 'campaign_name' THEN NULLIF(c.name, '')
      WHEN 'client_name' THEN NULLIF(cl.name, '')
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(s.email, '')
      WHEN 'event_type' THEN NULLIF(s.event_type, '')
      WHEN 'source_platform' THEN NULLIF(s.source_platform, '')
      WHEN 'resolution' THEN (COALESCE(s.resolution,'pending'))
      WHEN 'campaign_name' THEN NULLIF(c.name, '')
      WHEN 'client_name' THEN NULLIF(cl.name, '')
    END END) DESC NULLS LAST,
    s.occurred_at DESC, s.id
  LIMIT p_limit OFFSET p_offset;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_reply_rows(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_positive_only boolean DEFAULT false, p_dimension text DEFAULT NULL::text, p_value text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_company text[] DEFAULT NULL::text[], p_location text[] DEFAULT NULL::text[], p_sales_volume text[] DEFAULT NULL::text[], p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(id bigint, date_received timestamp with time zone, from_name text, from_email text, subject text, preview text, interested boolean, automated boolean, campaign_id bigint, campaign_name text, client_name text, lead_id bigint, company text, office_city text, sales_volume text, logged jsonb, total_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
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
    /*
     * 029 deliberately carries only the id and the date here — "pick the page
     * first, decorate second", which is what took this query from 1,190ms to
     * 310ms by not touching text_body 6,083 times to render 50 rows.
     *
     * from_name / from_email / subject are added because ORDER BY has to see
     * what it sorts on. They are three short columns off the same row, no extra
     * join and no large text — the expensive column, text_body, still stays out.
     */
    SELECT r.id, r.date_received, r.from_name, r.from_email_address, r.subject
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
      AND (NOT p_positive_only OR (r.sentiment = 'positive'))
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
    FROM scoped s
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'date_received' THEN (EXTRACT(EPOCH FROM s.date_received))::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'date_received' THEN (EXTRACT(EPOCH FROM s.date_received))::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'from_name' THEN NULLIF(s.from_name, '')
      WHEN 'from_email' THEN NULLIF(s.from_email_address, '')
      WHEN 'subject' THEN NULLIF(s.subject, '')
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'from_name' THEN NULLIF(s.from_name, '')
      WHEN 'from_email' THEN NULLIF(s.from_email_address, '')
      WHEN 'subject' THEN NULLIF(s.subject, '')
    END END) DESC NULLS LAST,
    s.date_received DESC, s.id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    r.id, r.date_received, r.from_name, r.from_email_address, r.subject,
    left(regexp_replace(COALESCE(r.text_body, ''), '\s+', ' ', 'g'), 180),
    (r.sentiment = 'positive'), r.automated_reply, r.campaign_id, c.name, cl.name, r.lead_id,
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
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_sender_groups(p_team_id bigint, p_group text DEFAULT 'domain'::text, p_min_sent integer DEFAULT 0, p_sort text DEFAULT NULL::text, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(label text, inboxes bigint, sent bigint, bounced bigint, replied bigint, bounce_rate numeric, reply_rate numeric)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    COALESCE(
      CASE WHEN p_group = 'provider' THEN s.provider ELSE s.domain END,
      'unknown'
    ) AS label,
    COUNT(*),
    SUM(COALESCE(s.lifetime_sent, 0)),
    SUM(COALESCE(s.lifetime_bounced, 0)),
    SUM(COALESCE(s.unique_replied, 0)),
    CASE WHEN SUM(COALESCE(s.lifetime_sent, 0)) > 0
         THEN SUM(COALESCE(s.lifetime_bounced, 0))::NUMERIC
              / SUM(COALESCE(s.lifetime_sent, 0)) END,
    CASE WHEN SUM(COALESCE(s.lifetime_sent, 0)) > 0
         THEN SUM(COALESCE(s.unique_replied, 0))::NUMERIC
              / SUM(COALESCE(s.lifetime_sent, 0)) END
  FROM sender_emails s
  WHERE s.team_id = p_team_id
    AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
  GROUP BY 1
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (SUM(COALESCE(s.lifetime_sent, 0)))::NUMERIC
      WHEN 'inboxes' THEN (COUNT(*))::NUMERIC
      WHEN 'bounced' THEN (SUM(COALESCE(s.lifetime_bounced, 0)))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN SUM(COALESCE(s.lifetime_sent,0)) > 0 THEN SUM(COALESCE(s.lifetime_bounced,0))::NUMERIC / SUM(COALESCE(s.lifetime_sent,0)) END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN SUM(COALESCE(s.lifetime_sent,0)) > 0 THEN SUM(COALESCE(s.unique_replied,0))::NUMERIC / SUM(COALESCE(s.lifetime_sent,0)) END)::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (SUM(COALESCE(s.lifetime_sent, 0)))::NUMERIC
      WHEN 'inboxes' THEN (COUNT(*))::NUMERIC
      WHEN 'bounced' THEN (SUM(COALESCE(s.lifetime_bounced, 0)))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN SUM(COALESCE(s.lifetime_sent,0)) > 0 THEN SUM(COALESCE(s.lifetime_bounced,0))::NUMERIC / SUM(COALESCE(s.lifetime_sent,0)) END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN SUM(COALESCE(s.lifetime_sent,0)) > 0 THEN SUM(COALESCE(s.unique_replied,0))::NUMERIC / SUM(COALESCE(s.lifetime_sent,0)) END)::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN '__none__' THEN NULL::TEXT
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN '__none__' THEN NULL::TEXT
    END END) DESC NULLS LAST,
    SUM(COALESCE(s.lifetime_sent, 0)) DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_sender_rows(p_team_id bigint, p_min_sent integer DEFAULT 0, p_search text DEFAULT NULL::text, p_sort text DEFAULT 'sent'::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0, p_dir text DEFAULT 'desc'::text)
 RETURNS TABLE(id bigint, email text, name text, domain text, provider text, status text, daily_limit integer, sent integer, bounced integer, replied integer, bounce_rate numeric, reply_rate numeric, total_count bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH filtered AS (
    SELECT s.*
    FROM sender_emails s
    WHERE s.team_id = p_team_id
      AND COALESCE(s.lifetime_sent, 0) >= p_min_sent
      AND (p_search IS NULL OR s.email ILIKE '%' || p_search || '%'
                            OR COALESCE(s.domain, '') ILIKE '%' || p_search || '%')
  )
  SELECT
    f.id, f.email, f.name, f.domain, f.provider, f.status, f.daily_limit,
    COALESCE(f.lifetime_sent, 0),
    COALESCE(f.lifetime_bounced, 0),
    COALESCE(f.unique_replied, 0),
    -- NULL, not 0, when nothing was sent: "no data" and "a 0% bounce rate" are
    -- different facts, and DASH is how the first one reaches the DOM.
    CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
         THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END,
    CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
         THEN f.unique_replied::NUMERIC / f.lifetime_sent END,
    COUNT(*) OVER ()
  FROM filtered f
  ORDER BY
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (COALESCE(f.lifetime_sent, 0))::NUMERIC
      WHEN 'bounced' THEN (COALESCE(f.lifetime_bounced, 0))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.unique_replied::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'daily_limit' THEN (COALESCE(f.daily_limit, 0))::NUMERIC
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'sent' THEN (COALESCE(f.lifetime_sent, 0))::NUMERIC
      WHEN 'bounced' THEN (COALESCE(f.lifetime_bounced, 0))::NUMERIC
      WHEN 'bounce_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'reply_rate' THEN (CASE WHEN COALESCE(f.lifetime_sent,0) > 0 THEN f.unique_replied::NUMERIC / f.lifetime_sent END)::NUMERIC
      WHEN 'daily_limit' THEN (COALESCE(f.daily_limit, 0))::NUMERIC
    END END) DESC NULLS LAST,
    (CASE WHEN p_dir = 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(f.email, '')
      WHEN 'domain' THEN NULLIF(f.domain, '')
      WHEN 'provider' THEN NULLIF(f.provider, '')
      WHEN 'status' THEN NULLIF(f.status, '')
    END END) ASC NULLS LAST,
    (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
      WHEN 'email' THEN NULLIF(f.email, '')
      WHEN 'domain' THEN NULLIF(f.domain, '')
      WHEN 'provider' THEN NULLIF(f.provider, '')
      WHEN 'status' THEN NULLIF(f.status, '')
    END END) DESC NULLS LAST,
    COALESCE(f.lifetime_sent, 0) DESC, f.id
  LIMIT p_limit OFFSET p_offset;
$function$
;


INSERT INTO schema_migrations (version) VALUES ('052_sortable_paginated_lists')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
