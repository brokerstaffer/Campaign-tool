import { NextResponse } from "next/server";
import { JOB_NAMES, getJob } from "@/lib/sync/jobs";
import { runJob } from "@/lib/sync/runner";
import { syncHealth } from "@/lib/sync/health";
import { safeEqual } from "@/lib/auth";

/*
 * The cron surface. One dynamic route rather than eight near-identical files —
 * the auth check, the lock and the run-history write are the same for every job,
 * and duplicating them eight times is how one of them ends up unguarded.
 *
 * This is the trigger surface. Callers, in order of how often they fire:
 *
 *   - the Railway cron service, every 10 minutes, via scripts/cron-dispatch.mjs
 *   - a human, by hand, when something needs re-running now
 *
 * The cadence itself lives in src/lib/sync/schedule.ts, not in Railway's UI,
 * because the compiler checks it there: a job that is never scheduled is a
 * build error. Nothing in this file knows or cares what the schedule is.
 *
 * Every job is idempotent, so a missed tick costs freshness and nothing else.
 * That is the property that let this app drop webhooks entirely.
 */

export const dynamic = "force-dynamic";
// The deep sweeps make thousands of EmailBison calls; the platform default
// would cut them off mid-run and leave a stale lock behind.
export const maxDuration = 800;

const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ job: string }> },
) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed. An unset secret must not mean "open to the internet" —
    // /api/cron/* is exempt from the auth proxy precisely because it carries
    // its own check.
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!safeEqual(presented, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { job } = await params;

  /*
   * `/api/cron/status` is health, not a job.
   *
   * It lives here rather than beside /api/sync/status so the cron dispatcher
   * can read it with the bearer token it already holds — reusing this exact,
   * already-verified auth check instead of opening a second authenticated
   * surface for one caller. "status" is not and must not become a job name;
   * JOB_NAMES is the registry, and this shadows anything added there.
   */
  if (job === "status") {
    return NextResponse.json(await syncHealth(false));
  }

  const fn = getJob(job);
  if (!fn) {
    return NextResponse.json(
      { error: `Unknown job "${job}"`, available: JOB_NAMES },
      { status: 404 },
    );
  }

  /*
   * `?detach=1` starts the job and answers immediately.
   *
   * Railway's edge times a request out well before a deep sweep finishes, so
   * triggering one by hand returns a 502 even though the run completes fine
   * server-side — misleading, and it makes an actual failure indistinguishable
   * from a slow success. The in-process scheduler never hits this because it
   * doesn't go through HTTP at all; only manual triggers do.
   *
   * Safe because this is a long-lived Node process, not a serverless function:
   * work continues after the response is written. The outcome lands in
   * `sync_runs`, which is where /api/sync/status reads it from.
   */
  const url = new URL(request.url);
  if (url.searchParams.get("detach") === "1") {
    void runJob(job, TEAM_ID, fn).catch((error) =>
      console.error(`[cron] ${job} (detached) threw:`, error),
    );
    return NextResponse.json(
      { job, status: "started", detached: true, followUp: "/api/sync/status" },
      { status: 202 },
    );
  }

  const outcome = await runJob(job, TEAM_ID, fn);

  // A failed job returns 500 so the scheduler's own alerting sees it; a skipped
  // one returns 200, because "already running" is the lock working, not a fault.
  return NextResponse.json(outcome, {
    status: outcome.status === "error" || outcome.status === "circuit-open" ? 500 : 200,
  });
}

/** Same handler under POST, for schedulers that only issue POSTs. */
export const POST = GET;
