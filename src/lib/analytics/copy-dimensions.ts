/*
 * The seven copy dimensions (spec §6.1).
 *
 * Fixed set, open values. The spec names these seven and no more, so they are a
 * constant rather than a table — but §6.3 says values "can be picked from the
 * existing list or added as you go", so the VALUES are free text discovered
 * from what has been tagged. A new value must never require a migration.
 *
 * The suggested values below are the spec's own examples where it gives them,
 * and are only ever a starting list in the picker — never a whitelist.
 */

export const COPY_DIMENSIONS = [
  {
    key: "subject_line",
    label: "Subject Line",
    hint: "How the subject earns the open.",
    suggestions: ["Variable", "Direct", "Personalized", "Question", "Curiosity Gap"],
  },
  {
    key: "opening",
    label: "Opening",
    hint: "How the first line approaches the reader.",
    suggestions: ["Compliment", "Observation", "Mutual Connection", "Problem", "Direct Ask"],
  },
  {
    key: "preposition",
    label: "Preposition",
    hint: "How the offer is framed and positioned.",
    suggestions: ["Opportunity", "Comparison", "Scarcity", "Status", "Savings"],
  },
  {
    key: "social_proof",
    label: "Social Proof",
    hint: "What kind of credibility is used, if any.",
    suggestions: ["None", "Named Client", "Volume", "Peer Group", "Result"],
  },
  {
    key: "cta",
    label: "Call To Action",
    hint: "What the email asks the reader to do.",
    suggestions: ["Interest Check", "Book a Call", "Reply Yes", "Question", "Soft Ask"],
  },
  {
    key: "tone",
    label: "Tone / Style",
    hint: "Formal, casual, direct, and so on.",
    suggestions: ["Formal", "Casual", "Direct", "Warm", "Blunt"],
  },
  {
    key: "structure",
    label: "Structure",
    hint: "The shape of the message.",
    suggestions: ["Short", "Long", "Bulleted", "Narrative", "Two-liner"],
  },
] as const;

export type CopyDimensionKey = (typeof COPY_DIMENSIONS)[number]["key"];

export const COPY_DIMENSION_KEYS = COPY_DIMENSIONS.map((d) => d.key) as CopyDimensionKey[];

export function isCopyDimension(value: string): value is CopyDimensionKey {
  return (COPY_DIMENSION_KEYS as string[]).includes(value);
}

export function dimensionLabel(key: string): string {
  return COPY_DIMENSIONS.find((d) => d.key === key)?.label ?? key;
}

/*
 * A medal needs a floor (§6.1 shows the top three marked).
 *
 * Without one, a value tagged on a single step with 40 sends and one positive
 * reply wins every ranking, every time — the medal would mark the smallest
 * sample rather than the best copy. 500 sends is roughly a day of one campaign.
 */
export const MEDAL_MIN_SENT = 500;
export const MEDALS = ["🥇", "🥈", "🥉"] as const;

/**
 * Ranks by positive rate — "the column that matters most" — with reply rate as
 * the tie-break, and only over rows that clear the sample floor.
 */
export function awardMedals<T extends { sent: number; positive_rate: number | null; reply_rate: number | null }>(
  rows: T[],
): Map<T, string> {
  const eligible = rows
    .filter((r) => r.sent >= MEDAL_MIN_SENT && r.positive_rate != null)
    .sort(
      (a, b) =>
        (b.positive_rate ?? 0) - (a.positive_rate ?? 0) ||
        (b.reply_rate ?? 0) - (a.reply_rate ?? 0),
    );

  return new Map(eligible.slice(0, 3).map((row, i) => [row, MEDALS[i]]));
}
