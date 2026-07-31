"use client";

import { SERIES, SERIES_KEYS, type SeriesKey } from "@/lib/analytics/series.ts";
import { cn } from "@/lib/utils";

/*
 * Multi-select series toggles, each carrying its entity colour as a dot.
 *
 * The dot is not decoration: `human` (#1baf7a) sits below the 3:1 contrast
 * floor against the page surface, so colour alone can't be the identity
 * channel. The label does that work, and the dot only ties the chip to its line.
 */
export function SeriesChips({
  selected,
  onChange,
  mode,
}: {
  selected: SeriesKey[];
  onChange: (next: SeriesKey[]) => void;
  mode: "volume" | "rates";
}) {
  function toggle(key: SeriesKey) {
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : [...selected, key];
    // Never allow an empty chart — deselecting the last series would render an
    // axis with nothing in it, which reads as broken rather than as a choice.
    if (next.length) onChange(next);
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {SERIES_KEYS.map((key) => {
        const series = SERIES[key];
        const active = selected.includes(key);
        // In Rates mode a series without a rate is meaningless (Sent is the
        // denominator), so it's disabled rather than silently plotted flat.
        const unavailable = mode === "rates" && !series.hasRate;

        return (
          <button
            key={key}
            type="button"
            disabled={unavailable}
            aria-pressed={active}
            onClick={() => toggle(key)}
            title={unavailable ? `${series.label} has no rate` : series.note}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              unavailable
                ? "cursor-not-allowed border-transparent text-muted-foreground/35"
                : active
                  ? "border-border bg-accent font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{
                backgroundColor: active && !unavailable ? series.color : "transparent",
                boxShadow: active && !unavailable ? undefined : "inset 0 0 0 1px currentColor",
              }}
            />
            {series.label}
          </button>
        );
      })}
    </div>
  );
}
