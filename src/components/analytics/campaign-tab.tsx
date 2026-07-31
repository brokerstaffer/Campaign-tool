"use client";

import { KpiBand } from "./kpi-band";
import { Segmented } from "./segmented";
import { useAnalyticsFilters } from "./filters-context";
import { useKpis } from "./use-kpis";
import { ChartsView } from "./charts-view";
import { ClientsView } from "./clients-view";
import { CampaignsView } from "./campaigns-view";
import { type SubView } from "@/lib/analytics/query-params.ts";

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
        {filters.view === "charts" ? (
          <ChartsView />
        ) : filters.view === "clients" ? (
          <ClientsView />
        ) : (
          <CampaignsView />
        )}
      </div>
    </>
  );
}

