#!/usr/bin/env node
/*
 * cron-dispatch.mjs — what the Railway cron service runs.
 *
 *   node scripts/cron-dispatch.mjs [--dry-run]
 *
 * Railway sets a cron schedule per service, so nine jobs at five cadences would
 * mean nine services. Instead ONE service runs on the finest cadence
 * (every 10 minutes) and this script decides what is actually due, reading the
 * same src/lib/sync/schedule.ts the app does.
 *
 * That matters for more than tidiness: schedule.ts is checked by the compiler
 * in both directions, so a job that exists but is never scheduled is a build
 * error. Move the schedule into Railway's UI and that check is gone — adding a
 * job and forgetting to schedule it becomes a table that quietly stops
 * updating, with no error anywhere.
 *
 * This script only TRIGGERS. The work happens in the web service, which already
 * holds the jobs, the rate limiter and the database lock. Triggers are detached
 * so the cron container exits in seconds instead of idling for the length of
 * the longest sweep.
 *
 * Required environment: APP_URL, CRON_SECRET.
 */

import { dueJobsSince } from "../src/lib/sync/schedule.ts";

const DRY_RUN = process.argv.includes("--dry-run");
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const SECRET = process.env.CRON_SECRET;
// Must equal the cron interval: each scheduled minute then falls in exactly one
// window, so nothing fires twice and nothing is skipped.
const WINDOW_MINUTES = Number(process.env.CRON_WINDOW_MINUTES || 10);

if (!APP_URL || !SECRET) {
  console.error("Missing APP_URL or CRON_SECRET.");
  process.exit(1);
}

const now = new Date();
const due = dueJobsSince(now, WINDOW_MINUTES);

console.log(
  `[dispatch] ${now.toISOString()} — window ${WINDOW_MINUTES}m — ` +
    (due.length ? `due: ${due.join(", ")}` : "nothing due"),
);

if (!due.length || DRY_RUN) {
  if (DRY_RUN) console.log("[dispatch] dry run — nothing triggered.");
  process.exit(0);
}

let failed = 0;

for (const job of due) {
  try {
    const response = await fetch(`${APP_URL}/api/cron/${job}?detach=1`, {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await response.json().catch(() => ({}));

    if (response.ok || response.status === 202) {
      console.log(`[dispatch] ${job}: ${body.status ?? response.status}`);
    } else {
      failed++;
      console.error(`[dispatch] ${job}: HTTP ${response.status} ${JSON.stringify(body)}`);
    }
  } catch (error) {
    failed++;
    console.error(`[dispatch] ${job}: ${error.message}`);
  }
}

/*
 * Report the PREVIOUS cycle's health as well, so a red cron run in Railway
 * means something. Triggering is nearly always successful — the interesting
 * failure is a job that ran and broke, and that lands in sync_runs, not in the
 * trigger's response.
 */
try {
  const response = await fetch(`${APP_URL}/api/cron/status`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  if (response.ok) {
    const status = await response.json();
    if (status.degraded?.length) {
      console.error(`[dispatch] degraded jobs: ${status.degraded.join(", ")}`);
      failed++;
    }
  }
} catch {
  // Health reporting is advisory; never fail a dispatch over it.
}

// Non-zero marks the cron run red in Railway.
process.exit(failed ? 1 : 0);
