import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  CONVERSION_MEASURES,
  STAGE_ORDER,
  TERMINAL_TYPES,
  classifyPlatform,
  isStage,
  isTerminal,
  outcomeLabel,
} from "./outcomes.ts";

/*
 * classifyPlatform is the one rule standing between this dashboard and
 * attributing another sending platform's results to an EmailBison campaign, so
 * it gets the most coverage here. The shapes are the ones the live feed
 * actually sends: 456 integers, 644 UUIDs, 823 nulls.
 */
describe("classifyPlatform", () => {
  it("treats an integer as an EmailBison campaign", () => {
    assert.equal(classifyPlatform(128), "emailbison");
    assert.equal(classifyPlatform("55"), "emailbison");
  });

  it("treats a UUID as Instantly, in either case", () => {
    assert.equal(classifyPlatform("c2d128b4-5a38-4774-b877-4c6ab0811241"), "instantly");
    assert.equal(classifyPlatform("C2D128B4-5A38-4774-B877-4C6AB0811241"), "instantly");
  });

  it("treats a missing campaign as logged directly", () => {
    for (const value of [null, undefined, ""]) {
      assert.equal(classifyPlatform(value), "direct");
    }
  });

  it("never calls something EmailBison unless it is all digits", () => {
    // The failure that matters: anything mistaken for an integer here gets
    // Number()'d into a campaign id and credited to whatever campaign that is.
    for (const value of ["12a", "12-34", " ", "abc", "1.5", "-7", "1e3"]) {
      assert.notEqual(
        classifyPlatform(value),
        "emailbison",
        `${JSON.stringify(value)} must not be read as an EmailBison campaign id`,
      );
    }
  });

  it("does not accept a 36-character non-UUID as Instantly", () => {
    // An earlier version used /^[0-9a-f-]{36}$/, which matched this.
    assert.equal(classifyPlatform("------------------------------------"), "direct");
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(classifyPlatform(" 128 "), "emailbison");
  });
});

describe("outcome vocabulary", () => {
  it("keeps the funnel in progression order, not alphabetical or by size", () => {
    assert.deepEqual([...STAGE_ORDER], [
      "introduction",
      "phone_screen_scheduled",
      "phone_screen",
      "interview_scheduled",
      "interview",
      "hired",
    ]);
  });

  it("never lets a type be both a stage and a stopping point", () => {
    for (const type of TERMINAL_TYPES) {
      assert.ok(!isStage(type), `${type} is a stopping point, not a funnel stage`);
    }
    for (const type of STAGE_ORDER) {
      assert.ok(!isTerminal(type), `${type} is a funnel stage, not a stopping point`);
    }
  });

  it("labels an unmapped type instead of dropping it", () => {
    // The vocabulary is open — a type added upstream tomorrow must still render.
    assert.equal(outcomeLabel("second_interview"), "Second Interview");
    assert.equal(outcomeLabel("offer"), "Offer");
  });

  it("uses the mapped label where one exists", () => {
    assert.equal(outcomeLabel("no_show"), "No-show");
    assert.equal(outcomeLabel("we_they_rejected"), "Rejected");
  });

  it("only measures conversions against types the funnel knows", () => {
    for (const measure of CONVERSION_MEASURES) {
      for (const type of measure.types) {
        assert.ok(isStage(type), `${measure.label} counts ${type}, which is not a stage`);
      }
    }
  });
});
