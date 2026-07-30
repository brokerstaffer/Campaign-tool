"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useAnalyticsFilters } from "./filters-context";
import { QuickRangePills } from "./quick-range-pills";
import { RangePicker } from "./range-picker";
import { rangeLabel } from "@/lib/analytics/format.ts";
import { comparePeriod } from "@/lib/analytics/query-params.ts";

/*
 * The filter bar. Present on every analytics tab; whatever is set here applies
 * to every number and chart on the page.
 *
 * P0 ships the range controls and Compare previous — everything that needs no
 * data. The Campaigns and Clients multiselects arrive in P1 with
 * /api/analytics/filters, because a picker with nothing to pick is worse than
 * no picker.
 */
export function FilterBar() {
  const { filters, setFilters } = useAnalyticsFilters();

  const compare = filters.compare
    ? comparePeriod(filters.from, filters.to)
    : null;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b px-4">
      <QuickRangePills />

      <Separator orientation="vertical" className="h-4" />

      <RangePicker />

      <Separator orientation="vertical" className="h-4" />

      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={filters.compare}
          onCheckedChange={(checked) => setFilters({ compare: checked === true })}
          className="size-3.5"
        />
        Compare previous
      </label>

      {/* The comparison period is spelled out rather than left implicit —
          "vs the previous period" is exactly the kind of label that gets read
          three different ways by three different people. */}
      {compare ? (
        <span className="text-xs text-muted-foreground/70">
          vs {rangeLabel(compare.from, compare.to)}
        </span>
      ) : null}
    </div>
  );
}
