/*
 * Next's server-boot hook, and the optional in-process scheduler.
 *
 * OFF BY DEFAULT. Scheduling is Railway cron: a cron service in this project
 * runs scripts/cron-dispatch.mjs every 10 minutes and triggers whatever
 * src/lib/sync/schedule.ts says is due. This ticker is the fallback for
 * environments without a cron service — a laptop, a preview deploy, or Railway
 * cron being down — and is enabled with ENABLE_SCHEDULER=1.
 *
 * Running both at once is safe, not merely tolerable: runJob holds a database
 * lock, so whichever fires second is skipped. The default is off only because
 * one active scheduler is easier to reason about than two.
 *
 * The NEXT_RUNTIME guard is load-bearing — register() also runs for the Edge
 * runtime, which has neither the timer semantics we want nor Supabase access.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  if (process.env.ENABLE_SCHEDULER !== "1") {
    console.log("[cron] in-process scheduler off; Railway cron drives /api/cron/*");
    return;
  }

  const { startScheduler } = await import("./lib/sync/scheduler");
  startScheduler();
}
