/*
 * Next's server-boot hook. This is where the sync scheduler starts.
 *
 * Two guards, both load-bearing:
 *   - NEXT_RUNTIME === "nodejs" — register() also runs for the Edge runtime,
 *     which has no setInterval semantics we want and no Supabase access.
 *   - ENABLE_SCHEDULER — off by default in development, so running `npm run dev`
 *     doesn't quietly start making thousands of EmailBison calls from a laptop.
 *     Set it to "0" in production to disable, e.g. while backfilling by hand.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const enabled = process.env.ENABLE_SCHEDULER
    ? process.env.ENABLE_SCHEDULER !== "0"
    : process.env.NODE_ENV === "production";

  if (!enabled) {
    console.log("[cron] scheduler disabled (set ENABLE_SCHEDULER=1 to run it)");
    return;
  }

  const { startScheduler } = await import("./lib/sync/scheduler");
  startScheduler();
}
