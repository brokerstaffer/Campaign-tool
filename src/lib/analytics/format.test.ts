import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import {
  DASH,
  compactNumber,
  delta,
  duration,
  fullNumber,
  percent,
  rangeLabel,
  ratio,
} from "./format.ts";

/*
 * Fixtures are read off the reference screenshots. Where the written spec and a
 * screenshot disagree the screenshot wins — in particular the spec's "1 : 4,761"
 * example comes from a different dataset and is deliberately NOT used here.
 */

describe("compactNumber (KPI band)", () => {
  test("compacts at 1,000 with one decimal", () => {
    assert.equal(compactNumber(272389), "272.4K");
    assert.equal(compactNumber(102886), "102.9K");
    assert.equal(compactNumber(3679), "3.7K");
    assert.equal(compactNumber(1446), "1.4K");
    assert.equal(compactNumber(300000), "300.0K"); // keeps the trailing .0
  });

  test("renders below 1,000 exactly", () => {
    assert.equal(compactNumber(389), "389");
    assert.equal(compactNumber(0), "0");
  });

  test("scales past a million", () => {
    assert.equal(compactNumber(1_200_000), "1.2M");
  });

  test("nullish is a dash, never a zero", () => {
    assert.equal(compactNumber(null), DASH);
    assert.equal(compactNumber(undefined), DASH);
    assert.equal(compactNumber(NaN), DASH);
  });
});

describe("fullNumber (tables)", () => {
  test("groups without compacting", () => {
    assert.equal(fullNumber(272389), "272,389");
    assert.equal(fullNumber(3679), "3,679");
    assert.equal(fullNumber(14198), "14,198");
    assert.equal(fullNumber(389), "389");
  });
});

describe("percent", () => {
  test("KPI band uses one decimal", () => {
    assert.equal(percent(3679 / 272389), "1.4%"); // Reply Rate, screenshot: 1.4%
  });

  test("tables use two", () => {
    assert.equal(percent(3679 / 272389, 2), "1.35%");
    assert.equal(percent(389 / 3679, 2), "10.57%"); // Clients table Positive %
  });

  /*
   * Deliberately NOT asserting the KPI band's Positive Rate here.
   * Positive/Replies = 10.57% -> "10.6%", but the reference KPI band reads
   * 11.0%. See the OPEN QUESTION note in metrics.ts — until that denominator is
   * confirmed, pinning it in a test would just enshrine a guess.
   */

  test("nullish is a dash", () => {
    assert.equal(percent(null), DASH);
  });
});

describe("ratio (Lead to Email)", () => {
  test("formats sent/positive as 1 : N", () => {
    assert.equal(ratio(272389 / 389), "1 : 700"); // 700.23 -> 700
  });

  test("groups large ratios", () => {
    assert.equal(ratio(14198), "1 : 14,198");
  });

  test("zero positives is a dash, not Infinity", () => {
    // The caller passes null when positive === 0; guard both paths anyway.
    assert.equal(ratio(null), DASH);
    assert.equal(ratio(Infinity), DASH);
    assert.equal(ratio(0), DASH);
  });
});

describe("duration", () => {
  test("picks its own unit", () => {
    assert.equal(duration(2 * 86400), "2.0d");
    assert.equal(duration(12.3 * 3600), "12.3h");
    assert.equal(duration(4.7 * 60), "4.7m");
    assert.equal(duration(3600), "1.0h"); // exactly on the hour boundary
    assert.equal(duration(86400), "1.0d"); // exactly on the day boundary
  });

  test("sub-minute rounds into minutes rather than showing seconds", () => {
    assert.equal(duration(18), "0.3m");
  });

  test("nullish is a dash", () => {
    assert.equal(duration(null), DASH);
    assert.equal(duration(-1), DASH);
  });
});

describe("delta", () => {
  test("signs and tones the change", () => {
    assert.deepEqual(delta(0.089), { label: "+8.9%", tone: "up" });
    assert.deepEqual(delta(-0.58), { label: "-58%", tone: "down" });
    assert.deepEqual(delta(0), { label: "0%", tone: "flat" });
  });

  test("null when there is no comparison period", () => {
    assert.equal(delta(null), null);
  });
});

describe("rangeLabel", () => {
  test("renders the trigger label without a year", () => {
    assert.equal(rangeLabel("2026-06-30", "2026-07-30"), "Jun 30 – Jul 30");
  });

  test("is timezone-stable at the month boundary", () => {
    // Parsed as UTC, so a machine in UTC-8 still reads Jul 1, not Jun 30.
    assert.equal(rangeLabel("2026-07-01", "2026-07-01"), "Jul 1 – Jul 1");
  });
});
