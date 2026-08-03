-- 017_sender_bands.sql — the distribution behind the Infrastructure headline.
--
-- "Bounce rate 1.80%" is an average over 493 domains, and an average is the one
-- number that cannot tell you whether you have a broad problem or a short tail.
-- 1.80% could be every domain sitting at 1.8%, or 480 domains at 1.2% and 13 on
-- fire. Those need completely different responses.
--
-- This returns the shape: how many domains sit in each band, and how much
-- volume rides on each. It is what turns the page from a list into a story.
--
-- Banded per DOMAIN rather than per inbox because reputation attaches to the
-- domain — three inboxes on one bad domain is one problem, not three.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_sender_bands(
  p_team_id  BIGINT,
  p_min_sent INTEGER DEFAULT 1
)
RETURNS TABLE (
  band    TEXT,
  domains BIGINT,
  inboxes BIGINT,
  sent    BIGINT,
  bounced BIGINT
)
LANGUAGE sql STABLE AS $$
  WITH per_domain AS (
    SELECT
      COALESCE(s.domain, 'unknown')            AS domain,
      COUNT(*)                                 AS inboxes,
      SUM(COALESCE(s.lifetime_sent, 0))        AS sent,
      SUM(COALESCE(s.lifetime_bounced, 0))     AS bounced
    FROM sender_emails s
    WHERE s.team_id = p_team_id
    GROUP BY 1
    -- Domains that have never sent carry no reputation yet and would swamp the
    -- healthy band with meaningless zeros.
    HAVING SUM(COALESCE(s.lifetime_sent, 0)) >= p_min_sent
  )
  SELECT
    CASE
      WHEN d.bounced::NUMERIC / d.sent >= 0.03 THEN 'high'
      WHEN d.bounced::NUMERIC / d.sent >= 0.02 THEN 'watch'
      ELSE 'ok'
    END AS band,
    COUNT(*),
    SUM(d.inboxes),
    SUM(d.sent),
    SUM(d.bounced)
  FROM per_domain d
  GROUP BY 1;
$$;

INSERT INTO schema_migrations (version) VALUES ('017_sender_bands')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
