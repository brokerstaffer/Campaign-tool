/*
 * The metric contract. One pure function per derived metric.
 *
 * These are the reference implementation; the SQL RPCs implement the same
 * formulas server-side. When the two disagree, THIS file is right and the SQL
 * is the bug — that's the whole reason these exist as testable pure functions
 * rather than living only inside a stored procedure.
 *
 * Every function returns `null` (never 0, never NaN, never Infinity) when the
 * denominator makes it undefined. `null` is what format.ts turns into DASH.
 */

/** Replies / Sent. Screenshot: 3,679 / 272,389 = 1.35%. */
export function replyRate(replies: number, sent: number): number | null {
  return sent > 0 ? replies / sent : null;
}

/** Human Replies / Sent. Screenshot: ~1.28%. */
export function humanRate(humanReplies: number, sent: number): number | null {
  return sent > 0 ? humanReplies / sent : null;
}

/**
 * Positive / Replies. Clients table "Positive %": 389 / 3,679 = 10.57%.
 *
 * !! OPEN QUESTION — the denominator is not settled. !!
 *
 * The reference KPI band shows Positive Rate = 11.0% for the same period, which
 * is NOT 389/3,679 (that renders as 10.6%). It IS consistent with
 * 389 / Human Replies if Human Replies is between 3,520 and 3,549 — which the
 * band's "3.5K" permits.
 *
 * So the reference product may use two different denominators: Replies in the
 * table, Human Replies in the KPI band. Until that is confirmed against the
 * live product, the KPI band calls `positiveRate(positive, replies)` — matching
 * the table and the written spec — and any disagreement with the reference is a
 * known, documented gap rather than a silent one. Do not "fix" this by changing
 * the denominator in one place only; both call sites must move together.
 */
export function positiveRate(positive: number, replies: number): number | null {
  return replies > 0 ? positive / replies : null;
}

/** Bounces / Sent. */
export function bounceRate(bounces: number, sent: number): number | null {
  return sent > 0 ? bounces / sent : null;
}

/**
 * Emails needed to earn one positive reply — rendered by format.ratio() as
 * `1 : 700`. Screenshot: 272,389 / 389 = 700.2.
 *
 * Returns null (→ DASH) when there were no positive replies, rather than
 * Infinity. "1 : ∞" is not a number anyone wants on a dashboard.
 */
export function leadToEmail(sent: number, positive: number): number | null {
  return positive > 0 ? sent / positive : null;
}

/**
 * Median of a numeric sample. Returns null for an empty sample — NOT 0, because
 * "no replies yet" and "replies answered at once" must not render alike.
 *
 * Uses the midpoint convention for even-length samples.
 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Period-over-period change as a fraction: (current - previous) / previous.
 *
 * Returns null when the previous period was 0 — growth from nothing is
 * undefined, and rendering "+∞%" or "+100%" would both be lies.
 */
export function periodDelta(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}
