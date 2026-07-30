/*
 * The series registry — one source of truth for what a chartable metric is
 * called, what colour it is, and how it behaves in Rates mode.
 *
 * Colour follows the ENTITY, never the rank or the selection order. Deselecting
 * Replies must not repaint Human; if colours shifted with selection, every
 * screenshot a client ever took would mean something different later.
 *
 * The six hexes were validated as a set for lightness/chroma separation and for
 * distinguishability under colour-vision deficiency. `human` (#1baf7a) sits
 * below the 3:1 contrast floor against the page surface, which is why every
 * series is ALSO labelled — in its chip and in the crosshair tooltip. Colour is
 * never the only channel carrying the identity.
 */

export const SERIES_KEYS = [
  "sent",
  "replies",
  "human",
  "positive",
  "prospects",
  "bounces",
] as const;

export type SeriesKey = (typeof SERIES_KEYS)[number];

export interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  /** False when a rate is meaningless for this series (Sent is the denominator). */
  hasRate: boolean;
  /** Shown on the chip when the series has limited history. */
  note?: string;
}

export const SERIES: Record<SeriesKey, SeriesDef> = {
  sent: {
    key: "sent",
    label: "Sent",
    color: "var(--series-sent)",
    hasRate: false,
  },
  replies: {
    key: "replies",
    label: "Replies",
    color: "var(--series-replies)",
    hasRate: true,
  },
  human: {
    key: "human",
    label: "Human",
    color: "var(--series-human)",
    hasRate: true,
  },
  positive: {
    key: "positive",
    label: "Positive",
    color: "var(--series-positive)",
    hasRate: true,
  },
  prospects: {
    key: "prospects",
    label: "Prospects",
    color: "var(--series-prospects)",
    hasRate: false,
    // Per-day prospects come from campaign_day_stats, which is backfilled only
    // 90 days. Longer ranges are legitimately short on this one line.
    note: "90d history",
  },
  bounces: {
    key: "bounces",
    label: "Bounces",
    color: "var(--series-bounces)",
    hasRate: true,
  },
};

/** Selected by default, matching the reference screenshot's Charts view. */
export const DEFAULT_SERIES: SeriesKey[] = ["replies"];

export function isSeriesKey(value: string): value is SeriesKey {
  return (SERIES_KEYS as readonly string[]).includes(value);
}
