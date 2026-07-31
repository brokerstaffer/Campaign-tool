import { JOB_NAMES, getJob } from "./jobs";
import { runJob } from "./runner";
import { dueJobs, minuteKey } from "./schedule.ts";

/*
 * The in-process scheduler.
 *
 * This app runs as a single Railway service, so an internal ticker beats an
 * external scheduler on every axis that matters here: nothing extra to deploy,
 * no second copy of the secret, and the schedule lives beside the jobs it runs
 * instead of in a dashboard nobody reads.
 *
 * Correctness does not depend on it being the only caller. `runJob` holds a
 * database lock, so a second replica, a manual `/api/cron/<job>` call and this
 * ticker can all fire at once and exactly one will run. The HTTP routes stay as
 * the manual-trigger and external-scheduler path.
 *
 * Due-ness is computed from the wall clock by modulo, not from an interval
 * counter, so a restart resumes the same cadence rather than restarting the
 * phase — a crash-looping deploy can't turn the 3-hourly job into a 30-second
 * one.
 */

const TEAM_ID = Number(process.env.EMAILBISON_TEAM_ID || 2);

let started = false;
let lastMinute: number | null = null;

async function tick() {
  const now = new Date();
  const key = minuteKey(now);
  // The 30s cadence means each minute is visited twice; only the first counts.
  if (key === lastMinute) return;
  lastMinute = key;

  for (const job of dueJobs(now)) {
    const fn = getJob(job);
    if (!fn) continue;
    // Deliberately not awaited in series: a 6-minute deep sweep must not delay
    // the 10-minute reply sync behind it.
    void runJob(job, TEAM_ID, fn).then((outcome) => {
      if (outcome.status !== "skipped") {
        console.log(
          `[cron] ${outcome.job} ${outcome.status} in ${outcome.durationMs}ms` +
            (outcome.rowsWritten !== undefined ? ` (${outcome.rowsWritten} rows)` : "") +
            (outcome.error ? ` — ${outcome.error}` : ""),
        );
      }
    });
  }
}

export function startScheduler() {
  if (started) return;
  started = true;

  const timer = setInterval(() => {
    void tick().catch((error) => console.error("[cron] tick failed:", error));
  }, 30_000);
  // Never hold the process open for the sake of the ticker.
  timer.unref?.();

  console.log(`[cron] scheduler started — ${JOB_NAMES.length} jobs registered`);
}
