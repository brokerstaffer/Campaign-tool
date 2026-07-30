"use client";

import { useAnalyticsFilters } from "./filters-context";
import { cn } from "@/lib/utils";
import type { Preset } from "@/lib/analytics/query-params.ts";

const PRESETS: Array<{ value: Exclude<Preset, "custom">; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
];

/**
 * Selecting a preset clears any explicit from/to — otherwise a stale custom
 * range would linger in the URL and the next parse would resurrect it.
 */
export function QuickRangePills() {
  const { filters, setFilters } = useAnalyticsFilters();

  return (
    <div className="flex items-center gap-0.5">
      {PRESETS.map((preset) => {
        const active = filters.preset === preset.value;
        return (
          <button
            key={preset.value}
            type="button"
            aria-pressed={active}
            onClick={() =>
              setFilters({
                preset: preset.value,
                from: undefined,
                to: undefined,
              })
            }
            className={cn(
              "rounded-md px-2 py-1 text-xs transition-colors",
              active
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
