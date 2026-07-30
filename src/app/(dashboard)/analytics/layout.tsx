import { Suspense } from "react";
import { FiltersProvider } from "@/components/analytics/filters-context";
import { FilterBar } from "@/components/analytics/filter-bar";
import { TabBar } from "@/components/analytics/tab-bar";
import { toISODate } from "@/lib/analytics/query-params.ts";

/*
 * Shared chrome for all four analytics tabs: tab bar + filter bar.
 *
 * `today` is resolved HERE, on the server, and handed to the client via
 * FiltersProvider. If the client resolved "30d" against the browser's timezone
 * while the API resolved it against the team's, the two would silently disagree
 * about which 30 days — and the KPI band would not match the chart.
 *
 * TODO(P1): resolve `today` in teams.timezone rather than the server's, once
 * the teams table exists. Q3 settles which timezone that is.
 */
export default function AnalyticsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const today = toISODate(new Date());

  return (
    <FiltersProvider today={today}>
      {/* TabBar and FilterBar both read useSearchParams, so they need a
          Suspense boundary in the App Router. */}
      <Suspense fallback={<div className="h-22 shrink-0 border-b" />}>
        <TabBar />
        <FilterBar />
      </Suspense>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {children}
      </div>
    </FiltersProvider>
  );
}
