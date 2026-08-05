-- 044 — "a variant is not a step" applied to the remaining counters.
--
-- 043 fixed the Campaigns table. The same COUNT(*) over sequence_steps was
-- still being used in two more places, both on the Copy & Offer tab:
--
--   analytics_offer_source       "Sequence: N steps from <campaign>" on every
--                                offer card, and the number shown before a
--                                one-click deploy — so it overstated what was
--                                about to be pushed into other campaigns.
--   analytics_offer_suggestions  the step count on a suggested group.
--
-- The sequence is wired through the campaign table, the campaign detail, the
-- editor, the copy flow and the offer cards. One wrong definition of "step" is
-- wrong in every one of them at once, which is why this is a definition and not
-- a per-screen fix.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_offer_source(p_team_id BIGINT)
RETURNS TABLE (
  offer_id           UUID,
  source_campaign_id BIGINT,
  source_name        TEXT,
  chosen             BOOLEAN,
  step_count         BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH ranked AS (
    SELECT
      o.id AS offer_id,
      c.id AS campaign_id,
      c.name,
      (o.source_campaign_id = c.id) AS chosen,
      ROW_NUMBER() OVER (
        PARTITION BY o.id
        ORDER BY (o.source_campaign_id = c.id) DESC NULLS LAST,
                 COALESCE(c.lifetime_emails_sent, 0) DESC
      ) AS rank
    FROM offers o
    JOIN campaign_offers co ON co.offer_id = o.id
    JOIN campaigns c        ON c.id = co.campaign_id
    WHERE o.team_id = p_team_id
  )
  SELECT
    r.offer_id,
    r.campaign_id,
    r.name,
    COALESCE(r.chosen, FALSE),
    -- Steps only. A variant occupies an existing position rather than adding
    -- one, so counting it overstated the sequence about to be deployed.
    (SELECT COUNT(*) FROM sequence_steps s
      WHERE s.campaign_id = r.campaign_id AND NOT s.is_variant)
  FROM ranked r
  WHERE r.rank = 1;
$$;

INSERT INTO schema_migrations (version) VALUES ('044_variants_not_steps_everywhere')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';


BEGIN;

CREATE OR REPLACE FUNCTION analytics_offer_suggestions(
  p_team_id BIGINT,
  p_from    DATE,
  p_to      DATE
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

COMMIT;

NOTIFY pgrst, 'reload schema';
