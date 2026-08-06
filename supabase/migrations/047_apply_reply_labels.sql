-- 047 — the writer for the MasterInbox label feed.
--
-- WHY AN RPC RATHER THAN AN UPSERT. `replies` is a cache of EmailBison, and the
-- sentiment columns are the only locally-owned ones on it. An upsert would send
-- a whole row and PostgREST builds its ON CONFLICT column list from the union of
-- keys across the batch — which is exactly how the outcomes job once reset 63
-- resolved rows to pending (see the note in jobs.ts). The rule there applies
-- here in the other direction: a job never writes a column it does not own, and
-- this one owns four.
--
-- So: an UPDATE of four named columns, joined against a JSONB payload, in one
-- statement. Rule 7 — the work happens in SQL, not in a loop of 3,500 calls.
--
-- CLEARING IS AS IMPORTANT AS SETTING. The feed reports a removed label as a row
-- with a null label, and a deleted thread as a tombstone. Both arrive here with
-- p_sentiment NULL and both must NULL the columns out, or Positive could only
-- ever go up and un-labelling something would never reach the dashboard.

BEGIN;

CREATE OR REPLACE FUNCTION apply_reply_labels(
  p_team_id BIGINT,
  p_rows    JSONB
)
RETURNS TABLE (labelled BIGINT, cleared BIGINT, unmatched BIGINT)
LANGUAGE plpgsql AS $$
DECLARE
  v_labelled BIGINT;
  v_cleared  BIGINT;
  v_total    BIGINT;
BEGIN
  CREATE TEMP TABLE _incoming ON COMMIT DROP AS
  SELECT * FROM jsonb_to_recordset(p_rows) AS x(
    reply_id     BIGINT,
    thread_id    TEXT,
    sentiment    TEXT,
    label        TEXT,
    assigned_by  TEXT,
    labelled_at  TIMESTAMPTZ
  );

  SELECT COUNT(*) INTO v_total FROM _incoming;

  /*
   * Only rows that actually change are written. Re-running this job is meant to
   * be a no-op, and 3,500 pointless row versions a run would churn the table for
   * nothing. `IS DISTINCT FROM` rather than `<>` so a NULL on either side
   * compares properly — which is the whole clearing path.
   */
  WITH updated AS (
    UPDATE replies r
       SET sentiment        = i.sentiment,
           sentiment_label  = i.label,
           sentiment_source = CASE WHEN i.sentiment IS NULL THEN NULL ELSE 'masterinbox' END,
           sentiment_at     = i.labelled_at,
           label_thread_id  = i.thread_id
      FROM _incoming i
     WHERE r.id = i.reply_id
       AND r.team_id = p_team_id
       AND (r.sentiment       IS DISTINCT FROM i.sentiment
         OR r.sentiment_label IS DISTINCT FROM i.label
         OR r.label_thread_id IS DISTINCT FROM i.thread_id)
    RETURNING r.id, i.sentiment
  )
  SELECT COUNT(*) FILTER (WHERE sentiment IS NOT NULL),
         COUNT(*) FILTER (WHERE sentiment IS NULL)
    INTO v_labelled, v_cleared
    FROM updated;

  RETURN QUERY SELECT
    v_labelled,
    v_cleared,
    /*
     * Reply ids the feed offered that we do not hold. Reported rather than
     * ignored: a rising number means the two systems are drifting apart, which
     * is worth seeing. Measured at 187 of 4,127 on the first full walk —
     * replies on excluded or deleted campaigns.
     */
    v_total - (SELECT COUNT(*) FROM _incoming i JOIN replies r
                 ON r.id = i.reply_id AND r.team_id = p_team_id);
END;
$$;

INSERT INTO schema_migrations (version) VALUES ('047_apply_reply_labels')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
