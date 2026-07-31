import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { JOB_NAMES } from "@/lib/sync/jobs";
import { SCHEDULE_ENTRIES } from "@/lib/sync/schedule.ts";

/*
 * Sync health, behind the normal session auth.
 *
 * The failure mode this exists for is the quiet one: a cron stops firing, the
 * dashboard keeps rendering yesterday's numbers, and nobody notices for a week.
 *
 * Staleness is measured against each job's OWN cadence, not a flat threshold.
 * A flat one is wrong in both directions: it would call the nightly deep sweep
 * broken every afternoon, and it would call the 10-minute reply sync fine after
 * five hours of silence.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);

/**
 * How long a job may go without a success before it counts as stale.
 *
 * Four missed ticks for interval jobs, with a 45-minute floor so the 10-minute
 * sync doesn't cry stale over one slow run. 30 hours for daily jobs — enough
 * slack for a deploy that straddles the scheduled hour.
 */
const staleAfterMs = new Map(
  SCHEDULE_ENTRIES.map((entry) => [
    entry.job as string,
    entry.everyMinutes
      ? Math.max(entry.everyMinutes * 4 * 60_000, 45 * 60_000)
      : 30 * 3_600_000,
  ]),
);

export async function GET() {
  const sb = getSupabase();

  const [{ data: state }, { data: runs }] = await Promise.all([
    sb
      .from("sync_state")
      .select(
        "job_name, last_run_at, last_success_at, last_error, consecutive_failures, running_since",
      )
      .eq("team_id", TEAM_ID),
    sb
      .from("sync_runs")
      .select("job_name, started_at, finished_at, status, rows_written, api_calls, error")
      .eq("team_id", TEAM_ID)
      .order("started_at", { ascending: false })
      .limit(50),
  ]);

  const byJob = new Map((state ?? []).map((s) => [s.job_name, s]));
  const now = Date.now();

  const jobs = JOB_NAMES.map((job) => {
    const s = byJob.get(job);
    const lastSuccess = s?.last_success_at ? new Date(s.last_success_at).getTime() : null;
    const threshold = staleAfterMs.get(job) ?? 6 * 3_600_000;

    const status = !s
      ? "never-run"
      : (s.consecutive_failures ?? 0) >= 5
        ? "circuit-open"
        : !lastSuccess
          ? "never-succeeded"
          : now - lastSuccess > threshold
            ? "stale"
            : "ok";

    return {
      job,
      status,
      lastRunAt: s?.last_run_at ?? null,
      lastSuccessAt: s?.last_success_at ?? null,
      lastError: s?.last_error ?? null,
      consecutiveFailures: s?.consecutive_failures ?? 0,
      running: Boolean(s?.running_since),
      staleAfterMinutes: Math.round(threshold / 60_000),
    };
  });

  /*
   * `never-run` is reported but does NOT make the app unhealthy: a nightly job
   * on a service deployed this afternoon has simply not come round yet, and a
   * permanent red banner is a banner nobody reads. A job that has run and then
   * stopped — stale, failing, or never once succeeding — is the real signal.
   */
  const degraded = jobs.filter((j) => j.status !== "ok" && j.status !== "never-run");

  return NextResponse.json({
    jobs,
    healthy: degraded.length === 0,
    degraded: degraded.map((j) => j.job),
    neverRun: jobs.filter((j) => j.status === "never-run").map((j) => j.job),
    // Oldest successful sync among the healthy jobs — what a "data as of" line
    // in the header should read from.
    dataAsOf:
      jobs
        .map((j) => j.lastSuccessAt)
        .filter((v): v is string => Boolean(v))
        .sort()[0] ?? null,
    recentRuns: runs ?? [],
  });
}
