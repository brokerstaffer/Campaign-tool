"use client";

import { KpiBand } from "./kpi-band";
import { Segmented } from "./segmented";
import { useAnalyticsFilters } from "./filters-context";
import { useKpis } from "./use-kpis";
import { SUB_VIEWS, type SubView } from "@/lib/analytics/query-params.ts";

/*
 * The Campaign tab: KPI band, then a sub-view switcher.
 *
 * Sub-views are a URL param rather than separate routes because they share the
 * KPI band and every filter — a route change would remount the band and flash
 * it, which is exactly the shimmer the whole design is trying to avoid.
 *
 * Note: the reference has a fourth "Replies" sub-view. It is deliberately out
 * of scope — see the plan.
 */

const SUB_VIEW_OPTIONS: Array<{ value: SubView; label: string }> = [
  { value: "charts", label: "Charts" },
  { value: "clients", label: "Clients" },
  { value: "campaigns", label: "Campaigns" },
];

export function CampaignTab() {
  const { filters, setFilters } = useAnalyticsFilters();
  const { cells, isLoading } = useKpis();

  return (
    <>
      <KpiBand cells={cells} loading={isLoading} />

      <div className="border-b px-4">
        <Segmented
          aria-label="Sub-view"
          variant="full"
          value={filters.view}
          onValueChange={(view) => setFilters({ view })}
          options={SUB_VIEW_OPTIONS}
        />
      </div>

      <div className="flex-1 p-4">
        <SubViewPlaceholder view={filters.view} />
      </div>
    </>
  );
}

/** Temporary. Each of these becomes a real component in P3–P5. */
function SubViewPlaceholder({ view }: { view: SubView }) {
  const copy: Record<SubView, string> = {
    charts: "Daily volume and rate series.",
    clients: "Per-client rollup, derived from campaign names.",
    campaigns: "Campaign → variant → step, with the column picker.",
  };

  if (!SUB_VIEWS.includes(view)) return null;

  return (
    <div className="flex h-64 items-center justify-center rounded-lg border border-dashed">
      <p className="text-xs text-muted-foreground">{copy[view]}</p>
    </div>
  );
}
