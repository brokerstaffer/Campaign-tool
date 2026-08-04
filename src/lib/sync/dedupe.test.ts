import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { dedupeBy } from "./dedupe.ts";

describe("dedupeBy", () => {
  it("keeps the LAST occurrence — a later page is the fresher read", () => {
    const rows = [
      { id: 1, folder: "stale" },
      { id: 2, folder: "other" },
      { id: 1, folder: "fresh" },
    ];
    const out = dedupeBy(rows, "id");
    assert.equal(out.length, 2);
    assert.equal(out.find((r) => r.id === 1)?.folder, "fresh");
  });

  it("leaves an already-unique batch untouched, in order", () => {
    const rows = [{ id: 3 }, { id: 1 }, { id: 2 }];
    assert.deepEqual(dedupeBy(rows, "id"), rows);
  });

  it("handles composite conflict keys", () => {
    const rows = [
      { team_id: 1, stat_date: "2026-01-01", value: 1 },
      { team_id: 1, stat_date: "2026-01-02", value: 2 },
      { team_id: 2, stat_date: "2026-01-01", value: 3 },
      { team_id: 1, stat_date: "2026-01-01", value: 9 },
    ];
    const out = dedupeBy(rows, "team_id,stat_date");
    assert.equal(out.length, 3);
    assert.equal(out.find((r) => r.team_id === 1 && r.stat_date === "2026-01-01")?.value, 9);
  });

  it("tolerates whitespace in the conflict key spec", () => {
    const rows = [{ a: 1, b: 1 }, { a: 1, b: 1 }];
    assert.equal(dedupeBy(rows, "a, b").length, 1);
  });

  it("does not collide composite keys that a naive separator would merge", () => {
    // ("a","bc") and ("ab","c") both join to "abc" under an empty separator.
    const rows = [
      { x: "a", y: "bc", n: 1 },
      { x: "ab", y: "c", n: 2 },
    ];
    assert.equal(dedupeBy(rows, "x,y").length, 2);
  });

  it("treats distinct ids as distinct even when one stringifies alike", () => {
    // Guard against a future switch to a looser key: 1 and "1" are the same row
    // in Postgres for a bigint PK, so collapsing them is correct here.
    assert.equal(dedupeBy([{ id: 1 }, { id: "1" }], "id").length, 1);
  });

  it("returns an empty array for empty input", () => {
    assert.deepEqual(dedupeBy([], "id"), []);
  });
});
