import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { normaliseAttributeName, parseNumericValue } from "./lead-attributes.ts";

describe("parseNumericValue", () => {
  it("parses the currency shapes EmailBison actually sends", () => {
    // Real values sampled from the live workspace.
    assert.equal(parseNumericValue("$1,001,000"), 1001000);
    assert.equal(parseNumericValue("$27,528"), 27528);
    assert.equal(parseNumericValue("$455,000"), 455000);
    assert.equal(parseNumericValue("$250,250"), 250250);
    assert.equal(parseNumericValue("4"), 4);
    assert.equal(parseNumericValue("0"), 0);
  });

  it("keeps a real zero distinct from unknown", () => {
    // "closed rentals: 0" is a fact; a missing value is not.
    assert.equal(parseNumericValue("0"), 0);
    assert.equal(parseNumericValue(""), null);
    assert.equal(parseNumericValue(null), null);
    assert.equal(parseNumericValue(undefined), null);
  });

  it("returns null — never 0 — for anything it cannot parse", () => {
    /*
     * The failure that matters. Returning 0 here would drop every unparseable
     * agent into the lowest sales-volume band, which then looks like the
     * dominant segment. Null routes them to an explicit "Unknown" bucket.
     */
    for (const value of ["N/A", "n/a", "-", "—", "unknown", "$1M+", "1-5M", "abc", "$"]) {
      assert.equal(
        parseNumericValue(value),
        null,
        `${JSON.stringify(value)} must not parse to a number`,
      );
    }
  });

  it("does not truncate a qualified value to its leading digits", () => {
    // "$1M+" must not become 1. A wrong band is worse than an honest Unknown.
    assert.equal(parseNumericValue("$1M+"), null);
    assert.equal(parseNumericValue("500K"), null);
    assert.equal(parseNumericValue("12 units"), null);
  });

  it("handles decimals, negatives and whitespace", () => {
    assert.equal(parseNumericValue("  1234.56  "), 1234.56);
    assert.equal(parseNumericValue("-500"), -500);
    assert.equal(parseNumericValue("$1 001 000"), 1001000);
  });
});

describe("normaliseAttributeName", () => {
  it("makes the dimension join immune to upstream capitalisation", () => {
    assert.equal(normaliseAttributeName("Office City"), "office city");
    assert.equal(normaliseAttributeName("  sales   volume "), "sales volume");
    assert.equal(normaliseAttributeName("MLS Affiliation"), "mls affiliation");
  });

  it("is idempotent", () => {
    const once = normaliseAttributeName("Top  Producing City");
    assert.equal(normaliseAttributeName(once), once);
  });
});
