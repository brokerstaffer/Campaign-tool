import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SCHEDULE_ENTRIES, dueJobs, minuteKey } from "./schedule.ts";

const entries = SCHEDULE_ENTRIES;

/*
 * The two "does every job exist / is every job scheduled" checks are enforced
 * by the compiler in schedule.ts, not here — importing the registry would drag
 * the whole Supabase and EmailBison chain into a unit test.
 */

const at = (hh: number, mm: number) =>
  new Date(Date.UTC(2026, 6, 15, hh, mm, 0));

describe("sync schedule", () => {
  it("gives every entry exactly one cadence", () => {
    for (const entry of entries) {
      const hasInterval = entry.everyMinutes !== undefined;
      const hasDaily = entry.dailyAtUtcHour !== undefined;
      assert.ok(hasInterval !== hasDaily, `${entry.job} must have one cadence, not both or neither`);
    }
  });

  it("fires the 10-minute job on tens and nothing else off-cadence", () => {
    assert.ok(dueJobs(at(14, 10)).includes("sync-replies"));
    assert.ok(dueJobs(at(14, 20)).includes("sync-replies"));
    assert.deepEqual(dueJobs(at(14, 7)), []);
  });

  it("stacks the coarser cadences on the hour", () => {
    const due = dueJobs(at(14, 0));
    // 14:00 is a multiple of 10, 30 and 60 minutes, but not of 180.
    assert.deepEqual(due.sort(), [
      "sync-daily-series",
      "sync-entities",
      "sync-replies",
      "sync-reply-timing",
    ]);
  });

  it("fires the 3-hourly job only on multiples of three hours", () => {
    assert.ok(dueJobs(at(12, 0)).includes("sync-day-stats"));
    assert.ok(!dueJobs(at(13, 0)).includes("sync-day-stats"));
  });

  it("fires each nightly job once, at its own hour", () => {
    for (const entry of entries.filter((e) => e.dailyAtUtcHour !== undefined)) {
      const hour = entry.dailyAtUtcHour!;
      assert.ok(dueJobs(at(hour, 0)).includes(entry.job));
      // Not at :30 — a daily job that fired every minute of its hour would make
      // 60 full sweeps a night.
      assert.ok(!dueJobs(at(hour, 30)).includes(entry.job));
    }
  });

  it("staggers the nightly sweeps so they never collide", () => {
    const hours = entries.filter((e) => e.dailyAtUtcHour !== undefined).map(
      (e) => e.dailyAtUtcHour,
    );
    assert.equal(new Set(hours).size, hours.length, "two nightly jobs share an hour");
  });

  it("keys ticks by the minute", () => {
    assert.equal(minuteKey(at(14, 10)), minuteKey(new Date(at(14, 10).getTime() + 59_000)));
    assert.notEqual(minuteKey(at(14, 10)), minuteKey(at(14, 11)));
  });
});
