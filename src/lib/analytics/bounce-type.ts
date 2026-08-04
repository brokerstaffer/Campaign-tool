/**
 * Classifies a bounce notification from its subject line.
 *
 * Mirrors the `bounce_type` SQL function in 035 exactly. It exists in both
 * places because the SQL does the aggregation and this makes the rules
 * testable — if they ever diverge, the test below is what catches it.
 *
 * EMAILBISON HAS NO SOFT/HARD FIELD: campaign stats expose `bounced` only, the
 * daily series has one `Bounced` label, and a bounced reply's type is just
 * "Bounced". So the split is derived from the notification, which turns out to
 * be a near-complete census — 4,133 stored notifications against the 4,141
 * bounces EmailBison reports.
 *
 * CONSERVATIVE BY DESIGN: anything unrecognised is `unknown`, never `hard`.
 * A hard bounce means suppress the address, so guessing hard costs a real
 * recipient; guessing unknown costs nothing but a gap in a chart.
 */
export type BounceType = "hard" | "soft" | "unknown";

export function bounceType(subject: string | null | undefined): BounceType {
  if (!subject) return "unknown";
  const s = subject.toLowerCase();

  // Delay first. "Delivery Status Notification (Delay)" also contains the word
  // "delivery", so a hard-pattern check ahead of this would swallow it and
  // report a temporary retry as a permanent failure.
  if (s.includes("(delay)") || s.includes("delayed") || s.includes("temporar")) {
    return "soft";
  }

  if (
    s.includes("(failure)") ||
    s.startsWith("undeliverable") ||
    s.includes("delivery failed") ||
    s.includes("returning message to sender") ||
    s.includes("could not be delivered") ||
    s.includes("address not found")
  ) {
    return "hard";
  }

  return "unknown";
}
