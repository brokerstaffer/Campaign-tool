-- 016_infrastructure.sql — the sending side (spec §8).
--
-- "Volume, bounces and reply rate broken down by sending inbox, by domain, and
-- by email provider. Problem accounts surfaced by bounce rate, so a single bad
-- inbox can be spotted before it drags a campaign down."
--
-- SCALE IS THE DESIGN CONSTRAINT HERE. There are 1,470 sender emails, not the
-- handful the rest of this schema deals in. That rules out the pattern used
-- elsewhere of selecting rows and grouping in the route: PostgREST caps a
-- select at 1000 rows and truncates SILENTLY, so a by-domain rollup computed in
-- JS would quietly describe two thirds of the estate and look completely
-- plausible. Every aggregate below is therefore an RPC.
--
-- The counters are LIFETIME, straight off GET /api/sender-emails. Per-day
-- per-sender figures exist (campaign-events/stats?sender_email_ids[]) but cost
-- one call per sender — 1,470 a night — so they are a deliberate follow-up
-- rather than something to half-do now. The UI says these are lifetime.

BEGIN;

ALTER TABLE sender_emails
  -- CACHE OF EB. All present on the list response, so caching them is free.
  ADD COLUMN IF NOT EXISTS lifetime_sent         INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_bounced      INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_replied      INTEGER,
  ADD COLUMN IF NOT EXISTS unique_replied        INTEGER,
  ADD COLUMN IF NOT EXISTS unique_opened         INTEGER,
  ADD COLUMN IF NOT EXISTS lifetime_unsubscribed INTEGER,
  ADD COLUMN IF NOT EXISTS interested_leads      INTEGER,
  ADD COLUMN IF NOT EXISTS leads_contacted       INTEGER,
  ADD COLUMN IF NOT EXISTS warmup_enabled        BOOLEAN,
  ADD COLUMN IF NOT EXISTS eb_created_at         TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_sender_provider ON sender_emails (team_id, provider);
-- Partial: the problem-account query only ever looks at inboxes that have sent.
CREATE INDEX IF NOT EXISTS idx_sender_volume
  ON sender_emails (team_id, lifetime_sent DESC) WHERE lifetime_sent > 0;

/*
 * One row per inbox. Ordering and the minimum-volume floor are arguments rather
 * than hardcoded, because "worst bounce rate" over inboxes that have sent 3
 * emails is noise — one bounce out of three is 33% and means nothing.
 */
CREATE OR REPLACE FUNCTION analytics_sender_rows(
  p_team_id     BIGINT,
  p_min_sent    INTEGER DEFAULT 0,
  p_search      TEXT    DEFAULT NULL,
  p_sort        TEXT    DEFAULT 'sent',
  p_limit       INTEGER DEFAULT 200,
  p_offset      INTEGER DEFAULT 0
)
RETURNS TABLE (
  id            BIGINT,
  email         TEXT,
  name          TEXT,
  domain        TEXT,
  provider      TEXT,
  status        TEXT,
  daily_limit   INTEGER,
  sent          INTEGER,
  bounced       INTEGER,
  replied       INTEGER,
  bounce_rate   NUMERIC,
  reply_rate    NUMERIC,
  total_count   BIGINT
)
LANGUAGE sql STABLE AS $$
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
    CASE WHEN p_sort = 'bounce_rate' THEN
      CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
           THEN f.lifetime_bounced::NUMERIC / f.lifetime_sent END
    END DESC NULLS LAST,
    CASE WHEN p_sort = 'reply_rate' THEN
      CASE WHEN COALESCE(f.lifetime_sent, 0) > 0
           THEN f.unique_replied::NUMERIC / f.lifetime_sent END
    END DESC NULLS LAST,
    CASE WHEN p_sort = 'sent' THEN COALESCE(f.lifetime_sent, 0) END DESC,
    f.id
  LIMIT p_limit OFFSET p_offset;
$$;

/*
 * Rollups by domain and by provider. `p_group` picks which, so the two
 * breakdowns cannot drift apart in their arithmetic — the failure mode where a
 * domain's reply rate and its provider's reply rate are computed differently
 * and neither reconciles with the inbox list.
 */
CREATE OR REPLACE FUNCTION analytics_sender_groups(
  p_team_id  BIGINT,
  p_group    TEXT DEFAULT 'domain',
  p_min_sent INTEGER DEFAULT 0
)
RETURNS TABLE (
  label       TEXT,
  inboxes     BIGINT,
  sent        BIGINT,
  bounced     BIGINT,
  replied     BIGINT,
  bounce_rate NUMERIC,
  reply_rate  NUMERIC
)
LANGUAGE sql STABLE AS $$
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
  ORDER BY SUM(COALESCE(s.lifetime_sent, 0)) DESC;
$$;

/** Headline totals, so the page's own numbers come from the same source. */
CREATE OR REPLACE FUNCTION analytics_sender_totals(p_team_id BIGINT)
RETURNS TABLE (
  inboxes       BIGINT,
  sending       BIGINT,
  domains       BIGINT,
  providers     BIGINT,
  sent          BIGINT,
  bounced       BIGINT,
  replied       BIGINT,
  bounce_rate   NUMERIC,
  reply_rate    NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE COALESCE(s.lifetime_sent, 0) > 0),
    COUNT(DISTINCT s.domain),
    COUNT(DISTINCT s.provider),
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
  WHERE s.team_id = p_team_id;
$$;

INSERT INTO schema_migrations (version) VALUES ('016_infrastructure')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
