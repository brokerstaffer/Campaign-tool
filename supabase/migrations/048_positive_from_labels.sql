-- 048 — Positive now means "labelled positive in MasterInbox".
--
-- The flip. 046 brought the labels in; this makes every metric read them.
--
--   Positive   118  ->  389   (Introduction 304 + Interested 85)
--   Negative     0  ->  2,243
--
-- 389 is exactly what the reference product showed. See 046 for why the old
-- number was wrong: only the label named "Interested" ever round-tripped into
-- EmailBison's flag, and "Introduction" -- the larger group -- never did.
--
-- SIX FUNCTIONS, ONE SUBSTITUTION: `r.interested` becomes
-- `r.sentiment = 'positive'`, everywhere it appears on the replies alias. The
-- bodies below are the LIVE definitions with that single change applied, rather
-- than retyped -- retyping six large functions to alter one predicate in each is
-- how an unrelated clause quietly changes.
--
-- NEGATIVE AND NEUTRAL NEEDED NO CHANGE. They have always read `r.sentiment`;
-- they were reading a column nothing wrote. columns.ts said the Sentiment group
-- could honestly show `+` and `~` but never `-`. It can now.
--
-- COPY & OFFER IS DELIBERATELY UNTOUCHED. Its Positive % comes from
-- EmailBison's per-step counter (`campaign_step_stats_daily.interested`), which
-- is what lets it say WHICH EMAIL earned the positive. A label belongs to a
-- conversation and cannot say that. Two sources, one screen each, both named --
-- rather than one source that silently loses step attribution.
--
-- `replies.interested` still syncs and is still returned by the reply-rows
-- function as an output column. It is no longer read by any metric.

BEGIN;

CREATE OR REPLACE FUNCTION public.analytics_campaign_rows(p_team_id bigint, p_from date, p_to date, p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_client_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(campaign_id bigint, campaign_name text, status text, client_name text, step_count bigint, variant_count bigint, sent bigint, prospects bigint, replies bigint, human_replies bigint, positive bigint, negative bigint, neutral bigint, bot_replies bigint, bounces bigint, median_reply_seconds numeric, avg_reply_seconds numeric, bounces_hard bigint, bounces_soft bigint, introductions bigint, phone_screens bigint, interviews bigint, hires bigint, outcomes_total bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH scoped AS (
    SELECT c.id, c.name, c.status, cc.client_id
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_campaign_ids IS NULL OR c.id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
  ),
  series AS (
    SELECT s.campaign_id,
           SUM(s.value) FILTER (WHERE s.metric = 'sent')    AS sent,
           SUM(s.value) FILTER (WHERE s.metric = 'bounces') AS bounces
    FROM eb_daily_series s
    WHERE s.team_id = p_team_id AND s.campaign_id <> 0
      AND s.stat_date BETWEEN p_from AND p_to
      AND s.campaign_id IN (SELECT id FROM scoped)
    GROUP BY s.campaign_id
  ),
  day_stats AS (
    SELECT d.campaign_id, SUM(d.total_leads_contacted) AS prospects
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
      AND d.campaign_id IN (SELECT id FROM scoped)
    GROUP BY d.campaign_id
  ),
  step_counts AS (
    SELECT st.campaign_id,
           COUNT(*) FILTER (WHERE NOT st.is_variant) AS steps,
           COUNT(*) FILTER (WHERE st.is_variant)     AS variants
    FROM sequence_steps st
    WHERE st.team_id = p_team_id
    GROUP BY st.campaign_id
  ),
  reply_stats AS (
    SELECT r.campaign_id,
           COUNT(*)                                            AS replies,
           COUNT(*) FILTER (WHERE NOT r.automated_reply)       AS human,
           COUNT(*) FILTER (WHERE (r.sentiment = 'positive'))                AS positive,
           COUNT(*) FILTER (WHERE r.sentiment = 'negative')    AS negative,
           COUNT(*) FILTER (WHERE r.sentiment = 'neutral')     AS neutral,
           COUNT(*) FILTER (WHERE r.automated_reply)           AS bots,
           PERCENTILE_CONT(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (r.date_received - r.first_send_at))
           ) FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS median_reply,
           AVG(EXTRACT(EPOCH FROM (r.date_received - r.first_send_at)))
             FILTER (WHERE r.first_send_at IS NOT NULL
                       AND r.date_received > r.first_send_at)  AS avg_reply
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.tracked_reply
      AND NOT r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  bounce_split AS (
    SELECT r.campaign_id,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'hard') AS hard,
           COUNT(*) FILTER (WHERE bounce_type(r.subject) = 'soft') AS soft
    FROM replies r
    WHERE r.team_id = p_team_id
      AND r.is_bounce_notification
      AND r.received_date BETWEEN p_from AND p_to
      AND r.campaign_id IN (SELECT id FROM scoped)
    GROUP BY r.campaign_id
  ),
  outcomes AS (
    SELECT o.resolved_campaign_id AS campaign_id,
           COUNT(*) FILTER (WHERE o.event_type = 'introduction') AS introductions,
           COUNT(*) FILTER (WHERE o.event_type IN ('phone_screen','phone_screen_scheduled')) AS phone_screens,
           COUNT(*) FILTER (WHERE o.event_type IN ('interview','interview_scheduled')) AS interviews,
           COUNT(*) FILTER (WHERE o.event_type = 'hired') AS hires,
           COUNT(*) AS total
    FROM outcome_events o
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND o.resolved_campaign_id IN (SELECT id FROM scoped)
    GROUP BY o.resolved_campaign_id
  )
  SELECT
    sc.id, sc.name, sc.status, cl.name,
    COALESCE(stc.steps, 0)::BIGINT,
    COALESCE(stc.variants, 0)::BIGINT,
    COALESCE(se.sent, 0)::BIGINT,
    COALESCE(ds.prospects, 0)::BIGINT,
    COALESCE(rs.replies, 0)::BIGINT,
    COALESCE(rs.human, 0)::BIGINT,
    COALESCE(rs.positive, 0)::BIGINT,
    COALESCE(rs.negative, 0)::BIGINT,
    COALESCE(rs.neutral, 0)::BIGINT,
    COALESCE(rs.bots, 0)::BIGINT,
    COALESCE(se.bounces, 0)::BIGINT,
    rs.median_reply,
    rs.avg_reply,
    COALESCE(bs.hard, 0)::BIGINT,
    COALESCE(bs.soft, 0)::BIGINT,
    COALESCE(oc.introductions, 0)::BIGINT,
    COALESCE(oc.phone_screens, 0)::BIGINT,
    COALESCE(oc.interviews, 0)::BIGINT,
    COALESCE(oc.hires, 0)::BIGINT,
    COALESCE(oc.total, 0)::BIGINT
  FROM scoped sc
  LEFT JOIN clients cl      ON cl.id = sc.client_id
  LEFT JOIN step_counts stc ON stc.campaign_id = sc.id
  LEFT JOIN series se       ON se.campaign_id = sc.id
  LEFT JOIN day_stats ds    ON ds.campaign_id = sc.id
  LEFT JOIN reply_stats rs  ON rs.campaign_id = sc.id
  LEFT JOIN bounce_split bs ON bs.campaign_id = sc.id
  LEFT JOIN outcomes oc     ON oc.campaign_id = sc.id
  ORDER BY COALESCE(se.sent, 0) DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_client_rows(p_team_id bigint, p_from date, p_to date, p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_client_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(client_id uuid, client_name text, campaign_count bigint, ambiguous_count bigint, sent bigint, prospects bigint, replies bigint, human_replies bigint, positive bigint, bounces bigint, median_reply_seconds numeric)
 LANGUAGE sql
 STABLE
AS $function$
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
           COUNT(*) FILTER (WHERE (r.sentiment = 'positive'))           AS positive,
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
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_kpis(p_team_id bigint, p_from date, p_to date, p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_client_ids uuid[] DEFAULT NULL::uuid[], p_compare boolean DEFAULT false)
 RETURNS TABLE(period text, range_from date, range_to date, sent bigint, prospects bigint, replies bigint, human_replies bigint, positive bigint, bounces bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
           COUNT(*) FILTER (WHERE (r.sentiment = 'positive'))          AS positive
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
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_reply_breakdown(p_team_id bigint, p_from date, p_to date, p_dimension text, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_positive_only boolean DEFAULT false, p_limit integer DEFAULT 12, p_company text[] DEFAULT NULL::text[], p_location text[] DEFAULT NULL::text[], p_sales_volume text[] DEFAULT NULL::text[])
 RETURNS TABLE(value text, replies bigint, positive bigint, sort_order integer, grand_total bigint, group_count bigint)
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  d reply_dimensions%ROWTYPE;
BEGIN
  SELECT * INTO d FROM reply_dimensions
   WHERE team_id = p_team_id AND key = p_dimension AND active
   ORDER BY client_id NULLS LAST LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
  WITH scoped AS (
    SELECT r.id, r.lead_id, (r.sentiment = 'positive') AS interested, cl.name AS client_name
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
      AND (NOT p_positive_only OR (r.sentiment = 'positive'))
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
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_reply_rows(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_positive_only boolean DEFAULT false, p_dimension text DEFAULT NULL::text, p_value text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_company text[] DEFAULT NULL::text[], p_location text[] DEFAULT NULL::text[], p_sales_volume text[] DEFAULT NULL::text[])
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
    FROM scoped s ORDER BY s.date_received DESC, s.id
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

CREATE OR REPLACE FUNCTION public.analytics_timeseries(p_team_id bigint, p_from date, p_to date, p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_client_ids uuid[] DEFAULT NULL::uuid[], p_exclude_weekends boolean DEFAULT false, p_compare boolean DEFAULT false)
 RETURNS TABLE(period text, stat_date date, sent bigint, prospects bigint, replies bigint, human bigint, positive bigint, bounces bigint)
 LANGUAGE sql
 STABLE
AS $function$
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
  -- Every day in range, so the chart has no holes.
  days AS (
    SELECT pr.period, d::DATE AS stat_date
    FROM periods pr,
         generate_series(pr.f, pr.t, INTERVAL '1 day') d
    -- Cold email volume collapses at weekends; including them makes every week
    -- read as a crash followed by a recovery. Filtering here rather than in the
    -- client because it changes the x domain, not just what's drawn.
    WHERE NOT p_exclude_weekends
       OR EXTRACT(ISODOW FROM d) < 6
  )
  SELECT
    dy.period,
    dy.stat_date,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'sent' AND s.stat_date = dy.stat_date), 0)::BIGINT,
    -- Per-day distinct leads. Does NOT sum to the Prospects KPI -- see the note
    -- in migration 005; that is correct behaviour for a distinct count.
    COALESCE((SELECT SUM(d.total_leads_contacted) FROM campaign_day_stats d
              WHERE d.team_id = p_team_id
                AND d.campaign_id IN (SELECT id FROM scoped)
                AND d.stat_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification AND NOT r.automated_reply
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT COUNT(*) FROM replies r
              WHERE r.team_id = p_team_id AND r.tracked_reply
                AND NOT r.is_bounce_notification AND (r.sentiment = 'positive')
                AND r.campaign_id IN (SELECT id FROM scoped)
                AND r.received_date = dy.stat_date), 0)::BIGINT,
    COALESCE((SELECT SUM(s.value) FROM eb_daily_series s
              WHERE s.team_id = p_team_id AND s.campaign_id <> 0
                AND s.campaign_id IN (SELECT id FROM scoped)
                AND s.metric = 'bounces' AND s.stat_date = dy.stat_date), 0)::BIGINT
  FROM days dy
  ORDER BY dy.period, dy.stat_date;
$function$
;


INSERT INTO schema_migrations (version) VALUES ('048_positive_from_labels')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
