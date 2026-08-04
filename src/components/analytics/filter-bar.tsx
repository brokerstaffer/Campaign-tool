"use client";

import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { useAnalyticsFilters } from "./filters-context";
import { QuickRangePills } from "./quick-range-pills";
import { RangePicker } from "./range-picker";
import { MultiSelect, type Option } from "./multi-select";
import { rangeLabel } from "@/lib/analytics/format.ts";
import { PLATFORMS, comparePeriod } from "@/lib/analytics/query-params.ts";

/*
 * The filter bar. Present on every analytics tab; whatever is set here applies
 * to every number and chart on the page.
 *
 * Whatever is set here applies to every number and chart on the page, and all
 * of it lives in the URL — so any view is a shareable link and the back button
 * steps through filter changes.
 */
const PLATFORM_LABEL: Record<string, string> = {
  emailbison: "EmailBison",
  instantly: "Instantly",
};

const PLATFORM_OPTIONS: Option[] = PLATFORMS.map((value) => ({
  value,
  label: PLATFORM_LABEL[value],
}));

export function FilterBar() {
  const { filters, setFilters } = useAnalyticsFilters();

  const { data: options } = useQuery<{ campaigns: Option[]; clients: Option[] }>({
    queryKey: ["filter-options"],
    queryFn: async () => {
      const r = await fetch("/api/analytics/filters");
      if (!r.ok) throw new Error("Failed to load filter options");
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const compare = filters.compare
    ? comparePeriod(filters.from, filters.to)
    : null;

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 overflow-x-auto border-b px-4">
      <QuickRangePills />

      <Separator orientation="vertical" className="h-4" />

      <RangePicker />

      <Separator orientation="vertical" className="h-4" />

      <MultiSelect
        label="Campaigns"
        options={options?.campaigns ?? []}
        selected={filters.campaignIds.map(String)}
        onChange={(next) => setFilters({ campaignIds: next.map(Number) })}
        emptyText="No campaigns found"
      />

      <MultiSelect
        label="Clients"
        options={options?.clients ?? []}
        selected={filters.clientIds}
        onChange={(clientIds) => setFilters({ clientIds })}
        emptyText="No clients found"
      />

      {/*
        Platform (WT §3). Real, not cosmetic: the outcomes feed carries both
        EmailBison and Instantly. It only changes the Attribution tab, because
        every send, reply and sender here comes from EmailBison — so the chips
        below say which tabs a selection actually affects rather than letting an
        empty chart read as a bug.
      */}
      <MultiSelect
        label="Platform"
        options={PLATFORM_OPTIONS}
        selected={filters.platforms}
        onChange={(platforms) =>
          setFilters({ platforms: platforms as typeof filters.platforms })
        }
        emptyText="No platforms"
      />

      {filters.platforms.length ? (
        <span className="flex shrink-0 items-center gap-1">
          {filters.platforms.map((platform) => (
            <button
              key={platform}
              type="button"
              onClick={() =>
                setFilters({
                  platforms: filters.platforms.filter((p) => p !== platform),
                })
              }
              className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs hover:bg-muted"
              aria-label={`Remove ${platform} filter`}
            >
              {PLATFORM_LABEL[platform] ?? platform}
              <X className="size-3 text-muted-foreground" />
            </button>
          ))}
        </span>
      ) : null}

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
