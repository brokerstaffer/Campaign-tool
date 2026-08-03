-- 020_copy_first_step_only.sql — copy analysis covers the FIRST email only.
--
-- On the product owner's direction: "make sure we use the first step only in
-- this analysis. I do not want next steps in this."
--
-- It is the right call and worth writing down why, because the previous version
-- silently mixed three very different things:
--
--   * A follow-up's subject line is not a choice. EmailBison prepends "Re: " to
--     any threaded step, so every step 2 and 3 in this workspace shares the
--     subject of the step 1 above it. Grouping by "Subject Line Type" across all
--     steps was therefore counting the same subject two or three times, weighted
--     by how many follow-ups each campaign happens to have.
--   * A follow-up's reply rate is largely a function of the first email that
--     preceded it, so attributing its replies to ITS copy is attributing an
--     effect to the wrong cause.
--   * Step 1 carries 92 of 268 steps but the bulk of first-touch volume; the
--     follow-ups were diluting the signal they were supposed to explain.
--
-- FIRST STEP means step_order = 1 AND its variants. Variants store step_order
-- NULL and point at their parent, and every variant in this workspace hangs off
-- a step-1 parent — which is exactly what A/B testing a first email produces.
-- Excluding them would drop the most deliberate copy decisions in the estate.

BEGIN;

CREATE OR REPLACE FUNCTION analytics_copy_steps(
  p_team_id      BIGINT,
  p_from         DATE,
  p_to           DATE,
  p_client_ids   UUID[]   DEFAULT NULL,
  p_campaign_ids BIGINT[] DEFAULT NULL
)
RETURNS TABLE (
  sequence_step_id BIGINT,
  campaign_id      BIGINT,
  campaign_name    TEXT,
  offer_id         UUID,
  subject          TEXT,
  sent             BIGINT,
  replies          BIGINT,
  positive         BIGINT,
  bounced          BIGINT,
  tags             JSONB
)
LANGUAGE sql STABLE AS $$
  WITH first_steps AS (
    -- The opening email, plus any variant of it. A variant carries step_order
    -- NULL and points at its parent, so it has to be resolved through the
    -- parent rather than by its own order.
    SELECT s.id
    FROM sequence_steps s
    WHERE s.team_id = p_team_id
      AND s.step_order = 1
      AND s.is_variant = FALSE
    UNION
    SELECT v.id
    FROM sequence_steps v
    JOIN sequence_steps p ON p.id = v.variant_from_step_id
    WHERE v.team_id = p_team_id
      AND v.is_variant
      AND p.step_order = 1
  ),
  scoped AS (
    SELECT
      s.sequence_step_id,
      s.campaign_id,
      SUM(s.sent)           AS sent,
      SUM(s.unique_replies) AS replies,
      SUM(s.interested)     AS positive,
      SUM(s.bounced)        AS bounced
    FROM campaign_step_stats_daily s
    JOIN campaign_clients cc ON cc.campaign_id = s.campaign_id
    JOIN first_steps f       ON f.id = s.sequence_step_id
    WHERE s.team_id = p_team_id
      AND s.stat_date BETWEEN p_from AND p_to
      -- Templates and internal lists are not evidence about what copy works.
      AND cc.excluded = FALSE
      AND (p_client_ids IS NULL OR cc.client_id = ANY(p_client_ids))
      AND (p_campaign_ids IS NULL OR s.campaign_id = ANY(p_campaign_ids))
    GROUP BY s.sequence_step_id, s.campaign_id
  )
  SELECT
    x.sequence_step_id,
    x.campaign_id,
    c.name,
    co.offer_id,
    st.email_subject,
    x.sent, x.replies, x.positive, x.bounced,
    COALESCE(
      (SELECT jsonb_object_agg(t.dimension, t.value)
         FROM copy_tags t
        WHERE t.sequence_step_id = x.sequence_step_id),
      '{}'::jsonb
    )
  FROM scoped x
  LEFT JOIN campaigns       c  ON c.id = x.campaign_id
  LEFT JOIN campaign_offers co ON co.campaign_id = x.campaign_id
  LEFT JOIN sequence_steps  st ON st.id = x.sequence_step_id
  ORDER BY x.sent DESC;
$$;

-- The single-dimension RPCs from 018 are superseded by analytics_copy_steps,
-- which the route now uses for every grouping. Dropped rather than left behind
-- silently disagreeing with the screen by counting follow-ups.
DROP FUNCTION IF EXISTS analytics_copy_dimension(BIGINT, TEXT, DATE, DATE, UUID[], BIGINT[]);
DROP FUNCTION IF EXISTS analytics_copy_coverage(BIGINT, TEXT, DATE, DATE, UUID[], BIGINT[]);

INSERT INTO schema_migrations (version) VALUES ('020_copy_first_step_only')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
