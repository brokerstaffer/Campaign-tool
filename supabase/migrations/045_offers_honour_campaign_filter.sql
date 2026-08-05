-- 045 — the Campaigns filter reaches the Offers section of Copy & Offer.
--
-- Both offer RPCs were written with a client filter and no campaign filter, so
-- `analytics_offer_rows` and `analytics_offer_suggestions` were the only
-- analytics reads in the app that ignored `campaign_ids` outright. Selecting
-- three campaigns shrank the KPI band, the chart, the Clients table, the
-- Campaigns table, the Replies view AND the copy table on this very page — and
-- left the offer cards and the suggested groups sitting above them unchanged,
-- still reporting the whole workspace.
--
-- Verified before the fix: campaign_ids=<3 campaigns> moved every other
-- endpoint from 182,193 sent to 36,695 and left /api/offers at 63,520.
--
-- A filtered-out campaign is removed from the offer's roll-up, not just from
-- its stats: the "N campaigns" count, the per-client split and the totals all
-- come from the same scoped set, so they stay consistent with each other. An
-- offer with no campaigns left in scope drops out of the list rather than
-- rendering as a row of zeroes.

BEGIN;

DROP FUNCTION IF EXISTS analytics_offer_rows(BIGINT, DATE, DATE, UUID[]);

CREATE FUNCTION analytics_offer_rows(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  offer_id      UUID,
  offer_name    TEXT,
  niche         TEXT,
  campaigns     BIGINT,
  sent          BIGINT,
  replies       BIGINT,
  positive      BIGINT,
  bounced       BIGINT,
  reply_rate    NUMERIC,
  positive_rate NUMERIC,
  bounce_rate   NUMERIC,
  clients       JSONB
)
LANGUAGE sql STABLE AS $$
  WITH scoped AS (
    SELECT c.id, cc.client_id, cl.name AS client_name
    FROM campaigns c
    JOIN campaign_clients cc ON cc.campaign_id = c.id
    LEFT JOIN clients cl     ON cl.id = cc.client_id
    WHERE c.team_id = p_team_id
      AND c.deleted_at IS NULL
      AND NOT cc.excluded
      AND (p_client_ids   IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR c.id        = ANY(p_campaign_ids))
  ),
  per_campaign AS (
    SELECT co.offer_id, sc.id AS campaign_id, sc.client_name,
           COALESCE(SUM(s.sent), 0)           AS sent,
           COALESCE(SUM(s.unique_replies), 0) AS replies,
           COALESCE(SUM(s.interested), 0)     AS positive,
           COALESCE(SUM(s.bounced), 0)        AS bounced
    FROM campaign_offers co
    JOIN scoped sc ON sc.id = co.campaign_id
    LEFT JOIN campaign_step_stats_daily s
           ON s.campaign_id = sc.id AND s.stat_date BETWEEN p_from AND p_to
    GROUP BY co.offer_id, sc.id, sc.client_name
  )
  SELECT
    o.id, o.name, o.niche,
    COUNT(pc.campaign_id)::BIGINT,
    COALESCE(SUM(pc.sent), 0)::BIGINT,
    COALESCE(SUM(pc.replies), 0)::BIGINT,
    COALESCE(SUM(pc.positive), 0)::BIGINT,
    COALESCE(SUM(pc.bounced), 0)::BIGINT,
    -- NULLIF so a zero denominator returns NULL, which renders as a dash rather
    -- than a confident 0.0%.
    SUM(pc.replies)::NUMERIC  / NULLIF(SUM(pc.sent), 0),
    SUM(pc.positive)::NUMERIC / NULLIF(SUM(pc.replies), 0),
    SUM(pc.bounced)::NUMERIC  / NULLIF(SUM(pc.sent), 0),
    COALESCE(
      (SELECT jsonb_agg(x ORDER BY x->>'sent' DESC)
         FROM (
           SELECT jsonb_build_object(
                    'client',   COALESCE(p2.client_name, 'Unassigned'),
                    'campaigns', COUNT(*),
                    'sent',      SUM(p2.sent),
                    'replies',   SUM(p2.replies),
                    'positive',  SUM(p2.positive)
                  ) AS x
           FROM per_campaign p2
           WHERE p2.offer_id = o.id
           GROUP BY COALESCE(p2.client_name, 'Unassigned')
         ) t),
      '[]'::jsonb
    )
  FROM offers o
  LEFT JOIN per_campaign pc ON pc.offer_id = o.id
  WHERE o.team_id = p_team_id
    -- An offer with nothing in scope is dropped rather than shown as zeroes.
    -- Unfiltered, every offer still has its campaigns, so the list is unchanged.
    AND ((p_client_ids IS NULL AND p_campaign_ids IS NULL) OR pc.campaign_id IS NOT NULL)
  GROUP BY o.id, o.name, o.niche
  ORDER BY COALESCE(SUM(pc.sent), 0) DESC;
$$;

DROP FUNCTION IF EXISTS analytics_offer_suggestions(BIGINT, DATE, DATE);

CREATE FUNCTION analytics_offer_suggestions(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_campaign_ids BIGINT[] DEFAULT NULL,
  p_client_ids   UUID[]   DEFAULT NULL
)
RETURNS TABLE (
  fingerprint     TEXT,
  example_subject TEXT,
  variants        BIGINT,
  campaigns       BIGINT,
  campaign_ids    BIGINT[],
  source_campaign_id BIGINT,
  source_name     TEXT,
  step_count      BIGINT,
  claimed         BIGINT,
  sent            BIGINT,
  replies         BIGINT,
  positive        BIGINT,
  bounced         BIGINT,
  reply_rate      NUMERIC,
  positive_rate   NUMERIC,
  bounce_rate     NUMERIC
)
LANGUAGE sql STABLE AS $$
  WITH openers AS (
    SELECT
      s.campaign_id,
      s.email_subject,
      normalize_subject(s.email_subject) AS fingerprint,
      COALESCE(c.lifetime_emails_sent, 0) AS lifetime,
      c.name AS campaign_name,
      (co.campaign_id IS NOT NULL) AS claimed
    FROM sequence_steps s
    JOIN campaigns c        ON c.id = s.campaign_id
    JOIN campaign_clients cc ON cc.campaign_id = s.campaign_id
    LEFT JOIN campaign_offers co ON co.campaign_id = s.campaign_id
    WHERE s.team_id = p_team_id
      AND s.step_order = 1
      AND s.is_variant = FALSE
      -- Templates and internal lists are not offers.
      AND cc.excluded = FALSE
      AND normalize_subject(s.email_subject) IS NOT NULL
      AND (p_campaign_ids IS NULL OR s.campaign_id = ANY(p_campaign_ids))
      AND (p_client_ids   IS NULL OR cc.client_id  = ANY(p_client_ids))
  ),
  ranked AS (
    SELECT o.*,
           ROW_NUMBER() OVER (PARTITION BY o.fingerprint ORDER BY o.lifetime DESC) AS rank
    FROM openers o
  ),
  stats AS (
    SELECT r.fingerprint,
           SUM(d.emails_sent)    AS sent,
           SUM(d.unique_replies) AS replies,
           SUM(d.interested)     AS positive,
           SUM(d.bounced)        AS bounced
    FROM ranked r
    LEFT JOIN campaign_day_stats d
           ON d.campaign_id = r.campaign_id
          AND d.stat_date BETWEEN p_from AND p_to
    GROUP BY r.fingerprint
  )
  SELECT
    r.fingerprint,
    MAX(r.email_subject) FILTER (WHERE r.rank = 1),
    COUNT(DISTINCT r.email_subject),
    COUNT(*),
    ARRAY_AGG(r.campaign_id ORDER BY r.lifetime DESC),
    MAX(r.campaign_id) FILTER (WHERE r.rank = 1),
    MAX(r.campaign_name) FILTER (WHERE r.rank = 1),
    -- Steps only; a variant is an alternative wording at an existing
    -- position, not an extra email in the sequence.
    (SELECT COUNT(*) FROM sequence_steps ss
      WHERE ss.campaign_id = MAX(r.campaign_id) FILTER (WHERE r.rank = 1)
        AND NOT ss.is_variant),
    -- Campaigns already attached to an offer, so the UI can show a proposal as
    -- partly or fully taken rather than offering to create a duplicate.
    COUNT(*) FILTER (WHERE r.claimed),
    COALESCE(MAX(s.sent), 0),
    COALESCE(MAX(s.replies), 0),
    COALESCE(MAX(s.positive), 0),
    COALESCE(MAX(s.bounced), 0),
    CASE WHEN MAX(s.sent) > 0 THEN MAX(s.replies)::NUMERIC / MAX(s.sent) END,
    CASE WHEN MAX(s.replies) > 0 THEN MAX(s.positive)::NUMERIC / MAX(s.replies) END,
    CASE WHEN MAX(s.sent) > 0 THEN MAX(s.bounced)::NUMERIC / MAX(s.sent) END
  FROM ranked r
  LEFT JOIN stats s ON s.fingerprint = r.fingerprint
  GROUP BY r.fingerprint
  ORDER BY COALESCE(MAX(s.sent), 0) DESC;
$$;

INSERT INTO schema_migrations (version) VALUES ('045_offers_honour_campaign_filter')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
