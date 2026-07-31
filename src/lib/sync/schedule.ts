import type { JOBS } from "./jobs";

/*
 * The cron cadence, as data.
 *
 * Cadence follows how fast each source actually changes, not how cheap it is:
 *
 *   replies       10 min  — the only metric anyone watches for during a day
 *   entities      30 min  — new campaigns and the client mapping
 *   daily series   1 h    — one call per campaign returns the WHOLE window, so
 *                           a 7-day sweep costs the same as a 1-day one
 *   reply timing   1 h    — a draining work queue, capped at 500 replies/run
 *   day stats      3 h    — 95 campaigns x 3 days = ~285 calls; the expensive one
 *
 * The nightly sweeps are drift repair: EmailBison revises recent days after the
 * fact (late bounces, delayed opens, `interested` flipped by hand), so a wide
 * re-fetch each night is what keeps last month's numbers from slowly diverging
 * from the source. They are staggered an hour apart so they never contend for
 * the same rate-limit budget.
 *
 * All times are UTC. 06:00–09:00 UTC is 02:00–05:00 in the workspace's
 * America/New_York timezone, i.e. the quietest sending window.
 */

/** Every job the registry actually implements. */
export type JobName = keyof typeof JOBS;

export interface ScheduleEntry {
  readonly job: JobName;
  /** Fires whenever minute-of-day is divisible by this. */
  readonly everyMinutes?: number;
  /** Fires once a day, at :00 of this UTC hour. */
  readonly dailyAtUtcHour?: number;
}

/*
 * `satisfies` rather than a type annotation, so the literal job names survive
 * for the exhaustiveness check below. `import type` above means this module
 * never loads jobs.ts at runtime — the link is purely a compile-time one.
 */
export const SCHEDULE = [
  { job: "sync-replies", everyMinutes: 10 },
  { job: "sync-entities", everyMinutes: 30 },
  { job: "sync-daily-series", everyMinutes: 60 },
  { job: "sync-reply-timing", everyMinutes: 60 },
  { job: "sync-day-stats", everyMinutes: 180 },
  { job: "sync-steps", dailyAtUtcHour: 6 },
  { job: "sync-daily-series-deep", dailyAtUtcHour: 7 },
  { job: "sync-day-stats-deep", dailyAtUtcHour: 8 },
  { job: "sync-replies-deep", dailyAtUtcHour: 9 },
] as const satisfies readonly ScheduleEntry[];

/*
 * Both directions, enforced by the compiler rather than by remembering:
 *
 *   - a scheduled name that isn't a registered job fails the `satisfies` above;
 *   - a registered job that is never scheduled fails here.
 *
 * The second is the one worth catching. Adding a job and forgetting to schedule
 * it has no symptom at all — no error, no log line, just a table that quietly
 * stops updating.
 */
type Unscheduled = Exclude<JobName, (typeof SCHEDULE)[number]["job"]>;
const _everyJobIsScheduled: Unscheduled extends never ? true : Unscheduled = true;
void _everyJobIsScheduled;

/**
 * SCHEDULE widened back to the interface.
 *
 * `as const` is what preserves the literal job names for the checks above, but
 * it also means each entry's type only carries the one cadence key it uses, so
 * `entry.everyMinutes` is a type error on a daily entry. Consumers that want to
 * read either key uniformly read this instead.
 */
export const SCHEDULE_ENTRIES: readonly ScheduleEntry[] = SCHEDULE;

/**
 * Which jobs are due at this instant.
 *
 * Pure and modulo-based rather than stateful, so it never drifts: a process
 * that restarts at 14:37 resumes the same cadence as one that has been up for a
 * week, and the schedule is testable without waiting an hour.
 */
export function dueJobs(
  now: Date,
  schedule: readonly ScheduleEntry[] = SCHEDULE,
): string[] {
  const hour = now.getUTCHours();
  const minute = now.getUTCMinutes();
  const minuteOfDay = hour * 60 + minute;

  return schedule
    .filter((entry) =>
      entry.everyMinutes
        ? minuteOfDay % entry.everyMinutes === 0
        : minute === 0 && hour === entry.dailyAtUtcHour,
    )
    .map((entry) => entry.job);
}

/** Stable key for "this minute", so a tick that fires twice only runs jobs once. */
export function minuteKey(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}
