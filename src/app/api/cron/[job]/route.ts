import { NextResponse } from "next/server";
import { JOB_NAMES, getJob } from "@/lib/sync/jobs";
import { runJob } from "@/lib/sync/runner";
import { safeEqual } from "@/lib/auth";

/*
 * The cron surface. One dynamic route rather than eight near-identical files —
 * the auth check, the lock and the run-history write are the same for every job,
 * and duplicating them eight times is how one of them ends up unguarded.
 *
 * Schedule (Railway):
 *   sync-replies            every 10 min
 *   sync-entities           every 30 min
 *   sync-daily-series       hourly
 *   sync-reply-timing       hourly     (a draining work queue, capped at 500/run)
 *   sync-day-stats          every 3 h
 *   sync-steps              nightly
 *   sync-daily-series-deep  nightly    (drift repair against EB's own corrections)
 *   sync-day-stats-deep     nightly
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
  const fn = getJob(job);
  if (!fn) {
    return NextResponse.json(
      { error: `Unknown job "${job}"`, available: JOB_NAMES },
      { status: 404 },
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
