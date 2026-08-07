-- 055 — one page of a campaign's leads, without probing replies three times each.
--
-- STRUCTURE COPIED FROM 029, deliberately: pick the page first, decorate second.
-- That migration is where a 1,190ms reply query became 310ms — the cost was not
-- carrying the body, it was TOUCHING it 6,083 times to produce 50 rows. A
-- campaign here has up to 18,575 sends and ~5,000 leads, and the decoration is
-- heavier (a reply probe and a custom-variable rollup per row), so the same
-- discipline applies with more force: the inner query selects ids and sort keys
-- and nothing else.
--
-- REPLIES, POSITIVE AND BOUNCES ARE JOINED, NOT STORED. The send feed offers all
-- three per send and 053 deliberately drops them: rule 3, one authority per
-- metric family. They come from `replies` here, the same table the KPI band and
-- the Replies tab count, so a lead's reply count on this screen agrees with
-- every other screen.
--
-- STATUS IS DERIVED, and only from things we can actually prove. `unsubscribed`
-- is NOT derivable — nothing local carries a per-lead unsubscribe — so it is
-- absent rather than guessed.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_campaign_lead_rows(
  p_team_id     BIGINT,
  p_campaign_id BIGINT,
  p_search      TEXT     DEFAULT NULL,
  p_status      TEXT[]   DEFAULT NULL,
  p_sort        TEXT     DEFAULT NULL,
  p_dir         TEXT     DEFAULT 'desc',
  p_limit       INTEGER  DEFAULT 50,
  p_offset      INTEGER  DEFAULT 0
)
RETURNS TABLE (
  lead_id       BIGINT,
  email         TEXT,
  first_name    TEXT,
  last_name     TEXT,
  company       TEXT,
  title         TEXT,
  lead_status   TEXT,
  status        TEXT,
  step_reached  INTEGER,
  sends         INTEGER,
  first_sent_at TIMESTAMPTZ,
  last_sent_at  TIMESTAMPTZ,
  opens         INTEGER,
  unique_opens  INTEGER,
  clicks        INTEGER,
  replies       BIGINT,
  positive      BIGINT,
  bounces       BIGINT,
  sender_email  TEXT,
  attributes    JSONB,
  total_count   BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH step_count AS (
    -- Once, not once per row.
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  ),
  scoped AS (
    /*
     * Ids and sort keys only. Every join that costs anything — the reply probe,
     * the attribute rollup, the sender lookup — happens after the page is cut.
     */
    SELECT
      cl.lead_id,
      cl.step_reached, cl.sends, cl.first_sent_at, cl.last_sent_at,
      cl.opens, cl.unique_opens, cl.clicks,
      l.email, l.first_name, l.last_name, l.company, l.title,
      CASE
        WHEN rp.bounced  THEN 'bounced'
        WHEN rp.positive THEN 'positive'
        WHEN rp.replied  THEN 'replied'
        WHEN cl.step_reached >= sc.steps THEN 'completed'
        ELSE 'contacted'
      END AS derived_status,
      rp.replies, rp.positives, rp.bounces
    FROM campaign_leads cl
    LEFT JOIN leads l ON l.id = cl.lead_id
    CROSS JOIN step_count sc
    /*
     * ONE index scan per lead, not three.
     *
     * This was three correlated EXISTS — bounced, positive, replied — each
     * probing `replies` for every lead in the campaign before the page was cut:
     * 7,302 probes to render 50 rows on a 2,434-lead campaign. Same shape as the
     * bug 029 fixed. One LATERAL aggregates all of it in a single pass, and it
     * returns the counts too, so the outer query no longer needs its own three
     * subqueries either.
     */
    LEFT JOIN LATERAL (
      SELECT
        bool_or(r.is_bounce_notification)                                  AS bounced,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification)          AS replied,
        bool_or(r.tracked_reply AND NOT r.is_bounce_notification
                AND r.sentiment = 'positive')                              AS positive,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification) AS replies,
        COUNT(*) FILTER (WHERE r.tracked_reply AND NOT r.is_bounce_notification
                           AND r.sentiment = 'positive')                   AS positives,
        COUNT(*) FILTER (WHERE r.is_bounce_notification)                   AS bounces
      FROM replies r
      WHERE r.campaign_id = cl.campaign_id AND r.lead_id = cl.lead_id
    ) rp ON TRUE
    WHERE cl.team_id = p_team_id
      AND cl.campaign_id = p_campaign_id
      AND (
        p_search IS NULL
        OR l.email      ILIKE '%' || p_search || '%'
        OR l.first_name ILIKE '%' || p_search || '%'
        OR l.last_name  ILIKE '%' || p_search || '%'
        OR l.company    ILIKE '%' || p_search || '%'
      )
  ),
  filtered AS (
    SELECT * FROM scoped
     WHERE p_status IS NULL OR derived_status = ANY(p_status)
  ),
  page AS (
    SELECT f.*, COUNT(*) OVER () AS total
    FROM filtered f
    /*
     * Four clauses — numeric asc/desc, text asc/desc — then the default. Same
     * shape as 052. p_sort NULL is the third click: everything collapses and
     * the default takes over.
     */
    ORDER BY
      (CASE WHEN p_dir = 'asc' THEN CASE p_sort
        WHEN 'sends' THEN f.sends::NUMERIC
        WHEN 'step_reached' THEN f.step_reached::NUMERIC
        WHEN 'opens' THEN f.opens::NUMERIC
        WHEN 'unique_opens' THEN f.unique_opens::NUMERIC
        WHEN 'clicks' THEN f.clicks::NUMERIC
        WHEN 'first_sent_at' THEN EXTRACT(EPOCH FROM f.first_sent_at)
        WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_sent_at)
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
        WHEN 'sends' THEN f.sends::NUMERIC
        WHEN 'step_reached' THEN f.step_reached::NUMERIC
        WHEN 'opens' THEN f.opens::NUMERIC
        WHEN 'unique_opens' THEN f.unique_opens::NUMERIC
        WHEN 'clicks' THEN f.clicks::NUMERIC
        WHEN 'first_sent_at' THEN EXTRACT(EPOCH FROM f.first_sent_at)
        WHEN 'last_sent_at' THEN EXTRACT(EPOCH FROM f.last_sent_at)
      END END) DESC NULLS LAST,
      (CASE WHEN p_dir = 'asc' THEN CASE p_sort
        WHEN 'email' THEN NULLIF(f.email, '')
        WHEN 'first_name' THEN NULLIF(f.first_name, '')
        WHEN 'company' THEN NULLIF(f.company, '')
        WHEN 'title' THEN NULLIF(f.title, '')
        WHEN 'status' THEN f.derived_status
      END END) ASC NULLS LAST,
      (CASE WHEN p_dir <> 'asc' THEN CASE p_sort
        WHEN 'email' THEN NULLIF(f.email, '')
        WHEN 'first_name' THEN NULLIF(f.first_name, '')
        WHEN 'company' THEN NULLIF(f.company, '')
        WHEN 'title' THEN NULLIF(f.title, '')
        WHEN 'status' THEN f.derived_status
      END END) DESC NULLS LAST,
      f.last_sent_at DESC NULLS LAST, f.lead_id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    p.lead_id, p.email, p.first_name, p.last_name, p.company, p.title,
    l.status,
    p.derived_status,
    p.step_reached, p.sends, p.first_sent_at, p.last_sent_at,
    p.opens, p.unique_opens, p.clicks,
    p.replies, p.positives, p.bounces,
    se.email,
    /*
     * Every custom variable as one JSONB blob rather than N named columns.
     * That is the point of 027's long-not-wide shape: a new variable upstream
     * becomes a row and a column-registry entry, with NO migration.
     */
    COALESCE(
      (SELECT jsonb_object_agg(la.name, la.value)
         FROM lead_attributes la
        WHERE la.lead_id = p.lead_id AND la.value IS NOT NULL),
      '{}'::jsonb
    ),
    p.total
  FROM page p
  LEFT JOIN leads l         ON l.id = p.lead_id
  LEFT JOIN campaign_leads c ON c.campaign_id = p_campaign_id AND c.lead_id = p.lead_id
  LEFT JOIN sender_emails se ON se.id = c.sender_email_id
  ORDER BY p.total DESC, p.last_sent_at DESC NULLS LAST, p.lead_id;
$$;

/** The status facet counts, so the filter can say how many are in each state. */
CREATE OR REPLACE FUNCTION analytics_campaign_lead_facets(
  p_team_id     BIGINT,
  p_campaign_id BIGINT
)
RETURNS TABLE (status TEXT, leads BIGINT)
LANGUAGE sql STABLE AS $$
  WITH step_count AS (
    SELECT COUNT(*)::INTEGER AS steps FROM sequence_steps ss
     WHERE ss.campaign_id = p_campaign_id AND NOT ss.is_variant
  )
  SELECT
    CASE
      WHEN rp.bounced  THEN 'bounced'
      WHEN rp.positive THEN 'positive'
      WHEN rp.replied  THEN 'replied'
      WHEN cl.step_reached >= sc.steps THEN 'completed'
      ELSE 'contacted'
    END,
    COUNT(*)
  FROM campaign_leads cl
  CROSS JOIN step_count sc
  LEFT JOIN LATERAL (
    SELECT
      bool_or(r.is_bounce_notification)                         AS bounced,
      bool_or(r.tracked_reply AND NOT r.is_bounce_notification) AS replied,
      bool_or(r.tracked_reply AND NOT r.is_bounce_notification
              AND r.sentiment = 'positive')                     AS positive
    FROM replies r
    WHERE r.campaign_id = cl.campaign_id AND r.lead_id = cl.lead_id
  ) rp ON TRUE
  WHERE cl.team_id = p_team_id AND cl.campaign_id = p_campaign_id
  GROUP BY 1
  ORDER BY COUNT(*) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('055_campaign_lead_rows_faster')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
