import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bounceType } from "./bounce-type.ts";

/*
 * Subjects taken verbatim from the live table, with their real counts, so this
 * pins the classifier against what actually arrives rather than what a bounce
 * notification is imagined to look like.
 */
describe("bounceType", () => {
  it("classifies every subject shape present in the live data", () => {
    const live: Array<[string, string, number]> = [
      ["Delivery Status Notification (Failure)", "hard", 3417],
      ["Delivery Status Notification (Delay)", "soft", 605],
      ["Undeliverable: Join a Zillow preferred brokerage?", "hard", 36],
      ["Undeliverable: Hiring Agents for Zillow Preferred leads", "hard", 23],
      ["Mail delivery failed: returning message to sender", "hard", 3],
    ];
    for (const [subject, expected] of live) {
      assert.equal(bounceType(subject), expected, subject);
    }
  });

  it("reads a delay as soft even though it says Delivery", () => {
    /*
     * The ordering trap. "Delivery Status Notification (Delay)" contains
     * "delivery"; a hard-first check would report a temporary retry as a
     * permanent failure and suppress a reachable address.
     */
    assert.equal(bounceType("Delivery Status Notification (Delay)"), "soft");
    assert.equal(bounceType("Message delayed: will retry"), "soft");
    assert.equal(bounceType("Temporary delivery problem"), "soft");
  });

  it("never guesses hard for something it does not recognise", () => {
    // Guessing hard costs a real recipient; unknown costs a gap in a chart.
    for (const subject of ["Re: your email", "Out of office", "", null, undefined, "hello"]) {
      assert.notEqual(bounceType(subject), "hard", String(subject));
    }
    assert.equal(bounceType("Re: your email"), "unknown");
  });

  it("is case-insensitive, as mail servers are inconsistent", () => {
    assert.equal(bounceType("UNDELIVERABLE: whatever"), "hard");
    assert.equal(bounceType("delivery status notification (FAILURE)"), "hard");
    assert.equal(bounceType("DELIVERY STATUS NOTIFICATION (DELAY)"), "soft");
  });
});
