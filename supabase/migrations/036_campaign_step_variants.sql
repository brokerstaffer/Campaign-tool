-- 036 — expose the variant parent so the Campaigns table can nest three levels.
--
-- WT §5.3: "Rows expand three levels deep — Campaign, Variant, Step", with "the
-- best performers marked with a medal". We shipped two: Campaign then a flat
-- list of steps, variants sitting among them with a small "variant" chip and no
-- indication of what they are a variant OF.
--
-- THE SPEC'S NESTING IS INVERTED RELATIVE TO THE DATA, and the data wins.
-- The walkthrough puts Variant above Step (a variant of the whole campaign,
-- containing steps). EmailBison attaches a variant to a STEP: step 30 is the
-- opener and step 31 is `variant_from_step_id = 30`, an alternative wording of
-- that one email. Measured: 97 campaigns, 16 with variants, 16 variant rows,
-- zero orphans — every variant points at exactly one step.
--
-- So the levels are Campaign > Step > Variant. Building the spec's shape would
-- mean inventing a "Variant 1" wrapper that every campaign has exactly one of,
-- which adds a row to click through and tells the reader nothing.
--
-- This only adds the parent id; the nesting and the medals are done in the API
-- and the view, where the comparison between a step and its variants lives.

BEGIN;

DROP FUNCTION IF EXISTS analytics_campaign_steps(BIGINT, DATE, DATE);

CREATE FUNCTION analytics_campaign_steps(
  p_campaign_id BIGINT,
  p_from        DATE,
  p_to          DATE
)
RETURNS TABLE (
  sequence_step_id     BIGINT,
  step_order           INTEGER,
  email_subject        TEXT,
  email_body           TEXT,
  wait_in_days         INTEGER,
  thread_reply         BOOLEAN,
  is_variant           BOOLEAN,
  variant_from_step_id BIGINT,
  sent                 BIGINT,
  leads_contacted      BIGINT,
  unique_replies       BIGINT,
  bounced              BIGINT,
  unsubscribed         BIGINT,
  interested           BIGINT
)
LANGUAGE sql STABLE AS $$
  SELECT
    st.id,
    st.step_order,
    st.email_subject,
    st.email_body,
    st.wait_in_days,
    COALESCE(st.thread_reply, FALSE),
    COALESCE(st.is_variant, FALSE),
    st.variant_from_step_id,
    COALESCE(SUM(s.sent), 0)::BIGINT,
    COALESCE(SUM(s.leads_contacted), 0)::BIGINT,
    COALESCE(SUM(s.unique_replies), 0)::BIGINT,
    COALESCE(SUM(s.bounced), 0)::BIGINT,
    COALESCE(SUM(s.unsubscribed), 0)::BIGINT,
    COALESCE(SUM(s.interested), 0)::BIGINT
  FROM sequence_steps st
  LEFT JOIN campaign_step_stats_daily s
         ON s.sequence_step_id = st.id
        AND s.stat_date BETWEEN p_from AND p_to
  WHERE st.campaign_id = p_campaign_id
  GROUP BY st.id, st.step_order, st.email_subject, st.email_body,
           st.wait_in_days, st.thread_reply, st.is_variant, st.variant_from_step_id
  -- Variants sort immediately after the step they belong to.
  ORDER BY COALESCE(st.step_order, 9999), st.is_variant, st.id;
$$;

INSERT INTO schema_migrations (version) VALUES ('036_campaign_step_variants')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
