/*
 * Splits an email into the parts a cold email is actually built from, for the
 * BLUEPRINT panel (spec §5.4: "A side panel breaks the message down into its
 * parts — the opening, the proof, the call to action").
 *
 * THIS IS A HEURISTIC AND THE UI SAYS SO. There is no tagging behind it — it
 * reads the text and guesses. That is worth shipping because the guess is
 * usually right and always checkable (the part it picked is shown, not just its
 * name), but presenting it as analysis would be a lie. The plan said the same:
 * "v1 is a heuristic — label it as such in the UI rather than presenting a guess
 * as analysis."
 *
 * The rules come from what these emails actually look like:
 *   - Greeting  a first line that addresses someone ("Hi {FIRST_NAME},")
 *   - CTA       the last sentence that asks something — a question, or a phrase
 *               like "open to" / "worth a chat"
 *   - Proof     a sentence carrying a number, a named brand, or a credential
 *   - Opening   whatever leads before the proof
 *   - Sign-off  trailing lines after the CTA ("Best, Nicole")
 *
 * Sentences are classified in priority order and each is used once, so a line
 * cannot be both the proof and the call to action.
 */

export interface BlueprintPart {
  key: "greeting" | "opening" | "proof" | "cta" | "signoff";
  label: string;
  text: string;
}

const LABEL: Record<BlueprintPart["key"], string> = {
  greeting: "Greeting",
  opening: "Opening",
  proof: "Proof",
  cta: "Call to action",
  signoff: "Sign-off",
};

/** Strips tags and entities so the split works on what the reader sees. */
export function toPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const GREETING = /^(hi|hey|hello|good (morning|afternoon|evening))\b/i;
const SIGNOFF = /^(best|thanks|thank you|regards|cheers|sincerely|warmly)\b/i;
const CTA_PHRASE =
  /\b(open to|worth a|interested in|let me know|would you|are you|can we|shall we|book|schedule|reply|call)\b/i;
/** A number, a currency figure, or a capitalised multi-word brand. */
const PROOF = /(\d[\d,.]*\s*(%|k\b|m\b)?|\$[\d,]+|\b[A-Z][a-z]+\s[A-Z][a-z]+\b)/;

export function buildBlueprint(body: string): BlueprintPart[] {
  const text = toPlainText(body);
  if (!text) return [];

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const parts: BlueprintPart[] = [];
  const used = new Set<number>();

  const push = (key: BlueprintPart["key"], i: number) => {
    if (used.has(i)) return;
    used.add(i);
    parts.push({ key, label: LABEL[key], text: lines[i] });
  };

  /*
   * The greeting is usually spintax'd — "{{Hi {FIRST_NAME},|Hello {FIRST_NAME},}}"
   * — so it starts with a brace and a plain ^(hi|hey) test misses it, labelling
   * the greeting "Opening" and pushing everything else down a slot. Leading
   * punctuation and brace characters are skipped before matching.
   */
  if (GREETING.test(lines[0].replace(/^[\s{}|]+/, ""))) push("greeting", 0);

  // Sign-off: trailing lines, from the end, while they still look like one.
  for (let i = lines.length - 1; i > 0; i--) {
    if (SIGNOFF.test(lines[i])) {
      push("signoff", i);
      // Everything after a sign-off line is the signature block.
      for (let j = i + 1; j < lines.length; j++) used.add(j);
      break;
    }
  }

  // CTA: the LAST unused line that asks something. Last, because these emails
  // build to the ask, and an early question is usually rhetorical.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used.has(i)) continue;
    if (lines[i].includes("?") || CTA_PHRASE.test(lines[i])) {
      push("cta", i);
      break;
    }
  }

  /*
   * Opening BEFORE proof, and the order matters.
   *
   * Claiming proof first stole the opening line whenever it happened to carry a
   * digit — "hiring 1-2 agents to join our brokerage" matched the number rule
   * and was labelled proof, pushing the actual proof ("closed $12,500,000 last
   * year") down into opening. The opening is positional (it leads), the proof
   * is a property of the content, so position is resolved first.
   */
  for (let i = 0; i < lines.length; i++) {
    if (!used.has(i)) {
      push("opening", i);
      break;
    }
  }

  // Proof: the first remaining line carrying a number or a brand.
  for (let i = 0; i < lines.length; i++) {
    if (used.has(i)) continue;
    if (PROOF.test(lines[i])) {
      push("proof", i);
      break;
    }
  }

  // Read in the order the recipient reads them, not the order guessed.
  const order: BlueprintPart["key"][] = ["greeting", "opening", "proof", "cta", "signoff"];
  return parts.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}
