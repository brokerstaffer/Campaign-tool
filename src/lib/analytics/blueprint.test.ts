import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildBlueprint, toPlainText } from "./blueprint.ts";

/** The real shape of these emails, taken from a live sequence step. */
const REAL = `<p>Hi {FIRST_NAME},<br><br>We're hiring 1–2 agents to join our brokerage and work directly with Zillow Preferred buyer inquiries.<br><br>Our team closed $12,500,000 last year across 41 transactions.<br><br>Would you be open to a brief conversation to see if this could be a fit on both sides?<br><br>Best,<br>Nicole Collins</p>`;

describe("toPlainText", () => {
  it("turns the stored HTML into what the recipient reads", () => {
    const out = toPlainText(REAL);
    assert.ok(!out.includes("<"), "no tags should survive");
    assert.ok(out.startsWith("Hi {FIRST_NAME},"));
    assert.ok(out.includes("Nicole Collins"));
  });

  it("keeps merge tags and spintax intact", () => {
    // These are single-brace and must not be mangled by the tag stripper.
    assert.equal(toPlainText("<p>Hi {FIRST_NAME}, {a|b}</p>"), "Hi {FIRST_NAME}, {a|b}");
  });

  it("decodes the entities EmailBison stores", () => {
    assert.equal(toPlainText("<p>a&nbsp;&amp;&nbsp;b</p>"), "a & b");
  });
});

describe("buildBlueprint", () => {
  it("finds each part of a real email", () => {
    const parts = buildBlueprint(REAL);
    const by = Object.fromEntries(parts.map((p) => [p.key, p.text]));

    assert.ok(by.greeting?.startsWith("Hi {FIRST_NAME}"));
    assert.ok(by.opening?.includes("hiring"));
    // Proof is the sentence carrying the numbers.
    assert.ok(by.proof?.includes("$12,500,000"));
    // CTA is the ask, not the earlier statement.
    assert.ok(by.cta?.includes("open to"));
    assert.ok(by.signoff?.startsWith("Best"));
  });

  it("never uses one line for two parts", () => {
    const parts = buildBlueprint(REAL);
    const texts = parts.map((p) => p.text);
    assert.equal(new Set(texts).size, texts.length, "each line is claimed once");
  });

  it("returns the parts in reading order", () => {
    const keys = buildBlueprint(REAL).map((p) => p.key);
    const expected = ["greeting", "opening", "proof", "cta", "signoff"];
    assert.deepEqual(keys, expected.filter((k) => keys.includes(k as never)));
  });

  it("degrades rather than throwing on odd input", () => {
    assert.deepEqual(buildBlueprint(""), []);
    assert.deepEqual(buildBlueprint("<p></p>"), []);
    // A single line is an opening and nothing else — no invented parts.
    const one = buildBlueprint("<p>Just checking in.</p>");
    assert.equal(one.length, 1);
    assert.equal(one[0].key, "opening");
  });

  it("does not mistake an early question for the call to action", () => {
    // The ask is the LAST question; these emails build to it.
    const parts = buildBlueprint(
      "<p>Hi Sam,<br><br>Busy week?<br><br>Would you be open to a chat?<br><br>Best,<br>Nicole</p>",
    );
    assert.ok(parts.find((p) => p.key === "cta")?.text.includes("open to a chat"));
  });
});
