-- 051 — scope outcomes by the client the feed named, not by a guessed campaign.
--
-- 049 gave every outcome its true owner and 050 withdrew 728 campaign guesses
-- that named the wrong client. This is the read half: without it, filtering
-- Attribution to a client still routes through
-- resolved_campaign_id -> campaign_clients, so an outcome that legitimately has
-- no campaign disappears from its own client's view.
--
-- Measured before this migration: Attribution scoped to "C21 Results - Elite
-- Team" showed 0 hires. MasterInbox says 3, and we now hold all 3 — they were
-- simply unreachable through a campaign join.
--
-- COALESCE, not a straight swap. The feed's client is preferred; the campaign's
-- owner is the fallback for any row predating this. Both agree wherever both
-- exist -- 466 of 496 feed-attributed rows already matched -- so the fallback
-- changes nothing today and stops the filter going blank on an old row.
--
-- `analytics_outcome_campaigns` is deliberately NOT changed to display the
-- feed's client. It groups BY campaign, so the client shown there is the
-- campaign's owner by definition. Only its filter moves.

BEGIN;

CREATE OR REPLACE FUNCTION public.analytics_outcome_campaigns(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_platforms text[] DEFAULT NULL::text[])
 RETURNS TABLE(campaign_id bigint, campaign_name text, client_name text, sent bigint, outcomes bigint, people bigint, by_type jsonb)
 LANGUAGE sql
 STABLE
AS $function$
  WITH scoped AS (
    SELECT o.resolved_campaign_id AS cid, o.email, o.event_type
    FROM outcome_events o
    JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.resolved_campaign_id IS NOT NULL
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR COALESCE(o.resolved_client_id, cc.client_id) = ANY(p_client_ids))
      AND (p_platforms  IS NULL OR o.source_platform = ANY(p_platforms))
  ),
  per_type AS (
    SELECT cid, event_type, COUNT(*) AS n FROM scoped GROUP BY cid, event_type
  ),
  totals AS (
    SELECT cid, COUNT(*) AS outcomes, COUNT(DISTINCT lower(email)) AS people
    FROM scoped GROUP BY cid
  ),
  volume AS (
    SELECT d.campaign_id, SUM(d.emails_sent) AS sent
    FROM campaign_day_stats d
    WHERE d.team_id = p_team_id AND d.stat_date BETWEEN p_from AND p_to
    GROUP BY d.campaign_id
  )
  SELECT
    t.cid, c.name, cl.name,
    COALESCE(v.sent, 0)::BIGINT,
    t.outcomes, t.people,
    (SELECT jsonb_object_agg(p.event_type, p.n) FROM per_type p WHERE p.cid = t.cid)
  FROM totals t
  LEFT JOIN campaigns c        ON c.id = t.cid
  LEFT JOIN campaign_clients m ON m.campaign_id = t.cid
  LEFT JOIN clients cl         ON cl.id = m.client_id
  LEFT JOIN volume v           ON v.campaign_id = t.cid
  ORDER BY t.outcomes DESC;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_outcome_coverage(p_team_id bigint, p_from date, p_to date)
 RETURNS TABLE(total bigint, attributed bigint, other_platform bigint, unattributed bigint, pending bigint, by_method jsonb, by_platform jsonb)
 LANGUAGE sql
 STABLE
AS $function$
  WITH scoped AS (
    SELECT * FROM outcome_events
    WHERE team_id = p_team_id AND NOT voided
      AND occurred_at::date BETWEEN p_from AND p_to
  )
  SELECT
    (SELECT COUNT(*) FROM scoped),
    (SELECT COUNT(*) FROM scoped WHERE resolved_campaign_id IS NOT NULL),
    (SELECT COUNT(*) FROM scoped WHERE source_platform = 'instantly'),
    -- Looked at, no EmailBison campaign found. The honest gap.
    (SELECT COUNT(*) FROM scoped
      WHERE resolution IS NOT NULL AND resolved_campaign_id IS NULL
        AND source_platform <> 'instantly'),
    -- Not looked at yet: different from "we looked and found nothing".
    (SELECT COUNT(*) FROM scoped WHERE resolution IS NULL),
    COALESCE((SELECT jsonb_object_agg(x.k, x.n) FROM
      (SELECT COALESCE(resolution,'pending') AS k, COUNT(*) AS n FROM scoped GROUP BY 1) x), '{}'::jsonb),
    COALESCE((SELECT jsonb_object_agg(y.k, y.n) FROM
      (SELECT source_platform AS k, COUNT(*) AS n FROM scoped GROUP BY 1) y), '{}'::jsonb);
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_outcome_events(p_team_id bigint, p_from date, p_to date, p_types text[] DEFAULT NULL::text[], p_platforms text[] DEFAULT NULL::text[], p_client_ids uuid[] DEFAULT NULL::uuid[], p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
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
  ORDER BY s.occurred_at DESC, s.id
  LIMIT p_limit OFFSET p_offset;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_outcome_timeline(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_platforms text[] DEFAULT NULL::text[])
 RETURNS TABLE(week date, event_type text, events bigint)
 LANGUAGE sql
 STABLE
AS $function$
  WITH scoped AS (
    SELECT
      date_trunc('week', o.occurred_at)::date AS wk,
      o.event_type
    FROM outcome_events o
    LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
    WHERE o.team_id = p_team_id
      AND NOT o.voided
      AND o.occurred_at::date BETWEEN p_from AND p_to
      AND (p_platforms    IS NULL OR o.source_platform      = ANY(p_platforms))
      AND (p_client_ids IS NULL OR COALESCE(o.resolved_client_id, cc.client_id) = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR o.resolved_campaign_id = ANY(p_campaign_ids))
  )
  SELECT wk, event_type, COUNT(*)
  FROM scoped
  GROUP BY wk, event_type
  ORDER BY wk, event_type;
$function$
;

CREATE OR REPLACE FUNCTION public.analytics_outcome_totals(p_team_id bigint, p_from date, p_to date, p_client_ids uuid[] DEFAULT NULL::uuid[], p_campaign_ids bigint[] DEFAULT NULL::bigint[], p_platforms text[] DEFAULT NULL::text[])
 RETURNS TABLE(event_type text, events bigint, people bigint, attributed bigint, unattributed bigint)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT
    o.event_type,
    COUNT(*),
    COUNT(DISTINCT lower(o.email)),
    COUNT(*) FILTER (WHERE o.resolved_campaign_id IS NOT NULL),
    COUNT(*) FILTER (WHERE o.resolved_campaign_id IS NULL)
  FROM outcome_events o
  LEFT JOIN campaign_clients cc ON cc.campaign_id = o.resolved_campaign_id
  WHERE o.team_id = p_team_id
    AND NOT o.voided
    AND o.occurred_at::date BETWEEN p_from AND p_to
    AND (p_platforms IS NULL OR o.source_platform = ANY(p_platforms))
    -- A client or campaign filter can only apply to outcomes we attributed;
    -- the rest are excluded rather than silently credited.
    AND (p_client_ids IS NULL OR COALESCE(o.resolved_client_id, cc.client_id) = ANY(p_client_ids))
    AND (p_campaign_ids IS NULL OR o.resolved_campaign_id = ANY(p_campaign_ids))
  GROUP BY o.event_type
  ORDER BY COUNT(*) DESC;
$function$
;


INSERT INTO schema_migrations (version) VALUES ('051_outcome_client_scope')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
