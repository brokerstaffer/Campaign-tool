/**
 * Parses an EmailBison custom-variable value into a number, where it is one.
 *
 * These arrive as formatted display strings — "$1,001,000", "$27,528", "4" —
 * because they were written for a merge tag, not for arithmetic. The sales-volume
 * bands in the Replies view are computed from the parsed number, so this function
 * decides which bar an agent lands in.
 *
 * IT RETURNS NULL RATHER THAN 0 WHEN IT CANNOT PARSE, AND THAT IS THE WHOLE
 * POINT. "We do not know this agent's volume" and "this agent sells nothing" are
 * different facts. Collapsing them would silently stack every unparseable value
 * into the lowest band and make it look like the biggest segment — the kind of
 * wrong that reads as a finding. `currency_band_label` maps null to its own
 * "Unknown" bucket, which is counted and shown.
 *
 * Deliberately strict: a value must be a plain number once currency and grouping
 * marks are removed. "N/A", "n/a", "-", "" and "$1M+" all return null.
 */
export function parseNumericValue(raw: string | null | undefined): number | null {
  if (raw == null) return null;

  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Strip currency symbols, thousands separators and surrounding whitespace —
  // but nothing else, so a value carrying units or a qualifier stays unparsed
  // rather than being silently truncated to its leading digits.
  const cleaned = trimmed.replace(/[$£€,\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Normalises a custom-variable name for use as a stable key.
 *
 * EmailBison returns them as typed by whoever built the import ("office city",
 * "Office City"), and the dimension config joins on this string. Lower-casing
 * and collapsing whitespace means a capitalisation change upstream does not
 * silently empty a chart.
 */
export function normaliseAttributeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
