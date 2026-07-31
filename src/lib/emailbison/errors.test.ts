import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { EmailBisonApiError } from "./client.ts";
import { assertApplied, describeEmailBisonError } from "./errors.ts";

/*
 * These are pinned against a REAL response captured from
 * PATCH /api/campaigns/69/update on 2026-07-31. Before this module existed the
 * UI showed "EmailBison 422 Unprocessable Content on /api/campaigns/69/update",
 * which tells an operator nothing they can act on — the campaign_audit_log
 * still has two rows proving it.
 */
const REAL_422 = {
  data: {
    success: false,
    message:
      "The max emails per day field must be greater than or equal to max new leads per day.",
    errors: {
      max_emails_per_day: [
        "The max emails per day field must be greater than or equal to max new leads per day.",
      ],
    },
  },
};

describe("describeEmailBisonError", () => {
  it("digs the message out of the `data` envelope", () => {
    // The whole bug: EmailBison wraps errors the way it wraps resources, so
    // reading the top level finds nothing and falls back to the status line.
    const error = new EmailBisonApiError("EmailBison 422 …", 422, REAL_422);
    assert.equal(
      describeEmailBisonError(error),
      "The max emails per day field must be greater than or equal to max new leads per day.",
    );
  });

  it("reads an unwrapped message too", () => {
    const error = new EmailBisonApiError("…", 422, { message: "Campaign not found" });
    assert.equal(describeEmailBisonError(error), "Campaign not found");
  });

  it("joins every validation reason, not just the first", () => {
    const error = new EmailBisonApiError("…", 422, {
      data: { errors: { name: ["Name is required."], limit: ["Limit must be a number."] } },
    });
    assert.equal(
      describeEmailBisonError(error),
      "Name is required. Limit must be a number.",
    );
  });

  it("falls back to the status line when the body offers nothing", () => {
    const error = new EmailBisonApiError("EmailBison 500 Server Error on /x", 500, null);
    assert.equal(describeEmailBisonError(error), "EmailBison 500 Server Error on /x");
  });

  it("handles a non-EmailBison error", () => {
    assert.equal(describeEmailBisonError(new Error("socket hang up")), "socket hang up");
    assert.equal(describeEmailBisonError("plain string"), "plain string");
  });
});

describe("assertApplied", () => {
  it("throws on success:false inside the data envelope", () => {
    // A 2xx with success:false would otherwise be reported as applied — the
    // silent failure spec §9.5 forbids.
    assert.throws(
      () => assertApplied(REAL_422, "/api/campaigns/69/update"),
      /max emails per day/,
    );
  });

  it("throws on an unwrapped success:false", () => {
    assert.throws(() => assertApplied({ success: false }, "/x"), /refused the change/);
  });

  it("passes a normal resource response through", () => {
    assert.doesNotThrow(() => assertApplied({ data: { id: 69, status: "paused" } }, "/x"));
  });

  it("passes an empty body through — pause answers 200 with no payload", () => {
    assert.doesNotThrow(() => assertApplied(null, "/x"));
  });

  it("does not mistake a `success` field on a list response", () => {
    // `data` as an array must not be treated as the envelope's contents.
    assert.doesNotThrow(() => assertApplied({ data: [{ success: false }] }, "/x"));
  });
});
