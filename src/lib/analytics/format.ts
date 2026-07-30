/*
 * Every rendering rule in the product, in one place.
 *
 * The single most important thing here is DASH. Every formatter returns it for
 * null/undefined/non-finite input, and it is the ONLY way an undefined metric
 * reaches the DOM. That makes "renders '-' when Positive is 0" true everywhere
 * for free, instead of being something 40 call sites have to remember.
 *
 * Formatting rules are reverse-engineered from the reference screenshots and
 * pinned by format.test.ts. Note that the KPI band and the tables format
 * numbers DIFFERENTLY on purpose:
 *   KPI band  272.4K · 3.7K · 389      (compact, scannable)
 *   tables    272,389 · 3,679 · 389    (exact, comparable, sortable by eye)
 */

export const DASH = "-";

type Numeric = number | null | undefined;

function isNumber(value: Numeric): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * KPI-band number. Compacts at 1,000 with one decimal: `3.7K`, `272.4K`,
 * `1.2M`. Below 1,000 renders exactly, so `389` stays `389`.
 */
export function compactNumber(value: Numeric): string {
  if (!isNumber(value)) return DASH;

  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1_000) return `${sign}${abs.toLocaleString("en-US")}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs < 1_000_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
}

/** Table number. Exact, with locale grouping: `272,389`. */
export function fullNumber(value: Numeric): string {
  if (!isNumber(value)) return DASH;
  return value.toLocaleString("en-US");
}

/**
 * A rate expressed as a fraction (0.0135), rendered as a percentage.
 * The KPI band uses 1 decimal (`1.4%`); tables use 2 (`1.35%`).
 */
export function percent(value: Numeric, digits = 1): string {
  if (!isNumber(value)) return DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * Lead-to-Email, rendered as a ratio string: `1 : 700`.
 * Callers pass `sent / positive`; this only formats.
 */
export function ratio(value: Numeric): string {
  if (!isNumber(value) || value <= 0) return DASH;
  return `1 : ${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Duration in SECONDS, auto-unit with one decimal.
 * `>= 1d` → `2.0d`, `>= 1h` → `12.3h`, else `4.7m`.
 * Sub-minute values still render as minutes (`0.3m`) rather than seconds —
 * a reply time of "18s" is noise, not signal, at this altitude.
 */
export function duration(seconds: Numeric): string {
  if (!isNumber(seconds) || seconds < 0) return DASH;

  const minutes = seconds / 60;
  const hours = minutes / 60;
  const days = hours / 24;

  if (days >= 1) return `${days.toFixed(1)}d`;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${minutes.toFixed(1)}m`;
}

export interface Delta {
  label: string;
  tone: "up" | "down" | "flat";
}

/**
 * Period-over-period change, as a fraction. Returns a tone alongside the label
 * because the CALLER decides whether up is good — a rise in Bounces is not a
 * green number, and encoding that here would put product judgement in a
 * formatter.
 */
export function delta(value: Numeric): Delta | null {
  if (!isNumber(value)) return null;
  const pct = value * 100;
  const rounded = Number(pct.toFixed(1));
  if (rounded === 0) return { label: "0%", tone: "flat" };
  return {
    label: `${rounded > 0 ? "+" : ""}${rounded}%`,
    tone: rounded > 0 ? "up" : "down",
  };
}

/** `Jun 30 – Jul 30` — the date-range trigger label. No year, matching the reference. */
export function rangeLabel(from: string, to: string): string {
  const format = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };
  return `${format(from)} – ${format(to)}`;
}
