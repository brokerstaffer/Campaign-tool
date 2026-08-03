import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getJob } from "@/lib/sync/jobs";
import { runJob } from "@/lib/sync/runner";

/*
 * Run a sync job on demand, from the UI.
 *
 * The cron routes authenticate with CRON_SECRET, which the browser does not and
 * should not hold. This is the same runJob — same lock, same run history, same
 * circuit breaker — reached through the session instead.
 *
 * Restricted to the jobs a person has a reason to trigger. sync-entities picks
 * up a campaign created seconds ago; the deep nightly sweeps take minutes and
 * exist to repair drift, so a button for them would only ever be a way to
 * hammer EmailBison by accident.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MANUAL_JOBS = ["sync-entities", "sync-steps", "sync-senders", "sync-replies"] as const;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const job = request.nextUrl.searchParams.get("job") ?? "sync-entities";
  if (!(MANUAL_JOBS as readonly string[]).includes(job)) {
    return NextResponse.json(
      { error: `Not runnable from here. Choose one of: ${MANUAL_JOBS.join(", ")}` },
      { status: 400 },
    );
  }

  const fn = getJob(job);
  if (!fn) return NextResponse.json({ error: `Unknown job "${job}"` }, { status: 404 });

  const outcome = await runJob(job, Number(process.env.EMAILBISON_TEAM_ID || 2), fn);

  return NextResponse.json(outcome, {
    // "skipped" means the lock held because the scheduled run is already in
    // flight — that is the system working, not a failure.
    status: outcome.status === "error" || outcome.status === "circuit-open" ? 500 : 200,
  });
}
