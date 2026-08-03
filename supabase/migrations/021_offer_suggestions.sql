-- 021_offer_suggestions.sql — the offer groups already exist in the data.
--
-- The Copy & Offer tab shipped with an empty "Add Group" card and an "Untagged"
-- row, i.e. a screen that does nothing until someone spends an afternoon on
-- data entry. That was the wrong shape: the product owner asked to "fetch the
-- sequences from all the campaigns and then combine them according to the
-- offer", and the combining is something the data can do itself.
--
-- Grouping campaigns by their normalised first-email subject over the live
-- workspace produces:
--
--     Join a Zillow preferred brokerage?          33 campaigns
--     Hiring Agents for Zillow Preferred leads    24 campaigns
--     Confidential Conversation?                   4
--     Opportunity with SERHANT.                    3
--     ...
--
-- Those ARE the offers. The screen should arrive full of proposals with a name
-- field, not empty with a plus sign.
--
-- Normalisation folds case, punctuation and merge tags, so "Join a Zillow
-- preferred brokerage?" and "Join a Zillow Preferred Brokerage?" are one group.
-- It deliberately does NOT fold city inserts — "Join a San Diego Zillow
-- preferred brokerage?" stays separate, because whether a geo-variant is the
-- same offer is a judgement, and merging two offers by accident is much harder
-- to notice than leaving two that should have been one.

BEGIN;

/*
 * Lowercase, drop merge tags, punctuation to space, collapse whitespace.
 * Deliberately the same shape as normalize() in lib/clients/match.ts — the
 * campaign-name matcher — so the two never disagree about what "the same text"
 * means.
 */
CREATE OR REPLACE FUNCTION normalize_subject(p_subject TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(
    trim(regexp_replace(
      regexp_replace(
        regexp_replace(lower(COALESCE(p_subject, '')), '\{[^}]*\}', ' ', 'g'),
        '[^a-z0-9]+', ' ', 'g'
      ),
      '\s+', ' ', 'g'
    )),
    ''
  );
$$;

/**
 * Campaigns clustered by their first email, with combined performance.
 *
 * One row per proposed offer. `campaign_ids` rides along so the UI can create
 * the offer and attach every campaign in a single action.
 */
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
    (SELECT COUNT(*) FROM sequence_steps ss
      WHERE ss.campaign_id = MAX(r.campaign_id) FILTER (WHERE r.rank = 1)),
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

INSERT INTO schema_migrations (version) VALUES ('021_offer_suggestions')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
