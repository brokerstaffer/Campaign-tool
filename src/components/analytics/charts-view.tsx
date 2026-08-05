"use client";

import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { useAnalyticsFilters } from "./filters-context";
import { Segmented } from "./segmented";
import { SeriesChips } from "./series-chips";
import { SeriesChart, type Point } from "./series-chart";

interface Response {
  points: Point[];
  /* May contain nulls: tail-aligned to `points`, so a shorter previous
     period leaves a gap at the oldest edge rather than dropping the newest. */
  compare?: Array<Point | null>;
  compareLabel?: { from: string; to: string };
}

export function ChartsView() {
  const { filters, setFilters, toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();

  const query = useQuery<Response>({
    queryKey: ["timeseries", qs],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/timeseries${qs ? `?${qs}` : ""}`);
      if (!response.ok) throw new Error("Failed to load chart data");
      return response.json();
    },
    // placeholderData (set globally) keeps the previous chart on screen while a
    // refetch is in flight, so changing a filter doesn't flash an empty axis.
    // On a failed refetch that means the last good data stays up and only a
    // toast reports the problem — a blank chart would be a worse lie.
    throwOnError: false,
  });

  if (query.error && query.isFetched) {
    toast.error("Failed to load chart data", { id: "timeseries-error" });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          aria-label="Chart mode"
          value={filters.mode}
          onValueChange={(mode) => setFilters({ mode })}
          options={[
            { value: "volume", label: "Volume" },
            { value: "rates", label: "Rates" },
          ]}
        />

        <SeriesChips
          selected={filters.series}
          mode={filters.mode}
          onChange={(series) => setFilters({ series })}
        />

        <div className="ml-auto flex items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={filters.normalize}
              onCheckedChange={(v) => setFilters({ normalize: v === true })}
              className="size-3.5"
            />
            Normalize
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={filters.excludeWeekends}
              onCheckedChange={(v) => setFilters({ excludeWeekends: v === true })}
              className="size-3.5"
            />
            Exclude weekends
          </label>
        </div>
      </div>

      {filters.compare ? (
        <p className="text-[11px] text-muted-foreground/70">
          {query.isFetching && !query.data
            ? "Loading comparison…"
            : query.data?.compareLabel
              ? "Dashed line shows the previous period."
              : null}
        </p>
      ) : null}

      <SeriesChart
        points={query.data?.points ?? []}
        compare={query.data?.compare}
        selected={filters.series}
        mode={filters.mode}
        normalize={filters.normalize}
        loading={query.isLoading}
      />
    </div>
  );
}
