"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  filtersToSearchParams,
  resolveFilters,
  type ResolvedFilters,
} from "@/lib/analytics/query-params.ts";

/*
 * Filter state lives in the URL, not in React state.
 *
 * That makes every view shareable, makes the browser back button step through
 * filter changes, and means a screenshot someone pastes into Slack can be
 * reopened exactly. The trade-off is that every change is a navigation, which
 * is why updates use router.replace({scroll:false}) rather than push — you
 * don't want twelve history entries from dragging a date range.
 *
 * `today` is injected from the server layout rather than read from the browser
 * clock. If the client resolved "30d" against its own timezone and the server
 * resolved it against the team's, the KPI band and the chart would silently
 * cover different windows.
 */

const TodayContext = createContext<string | null>(null);

export function FiltersProvider({
  today,
  children,
}: {
  today: string;
  children: React.ReactNode;
}) {
  return (
    <TodayContext.Provider value={today}>{children}</TodayContext.Provider>
  );
}

export interface UseAnalyticsFilters {
  filters: ResolvedFilters;
  today: string;
  /** Merges a partial change and rewrites the URL. */
  setFilters: (patch: Partial<ResolvedFilters>) => void;
  /** The current filters as a query string, for passing to API routes. */
  toQueryString: () => string;
}

export function useAnalyticsFilters(): UseAnalyticsFilters {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const today = useContext(TodayContext);
  if (!today) {
    throw new Error("useAnalyticsFilters must be used inside <FiltersProvider>");
  }

  const filters = useMemo(() => {
    try {
      return resolveFilters(new URLSearchParams(searchParams.toString()), today);
    } catch {
      // A hand-edited or stale URL must not blank the page. Fall back to the
      // defaults; the user sees a working dashboard rather than an error.
      return resolveFilters(new URLSearchParams(), today);
    }
  }, [searchParams, today]);

  const setFilters = useCallback(
    (patch: Partial<ResolvedFilters>) => {
      const next = filtersToSearchParams({ ...filters, ...patch });
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filters, pathname, router],
  );

  const toQueryString = useCallback(
    () => filtersToSearchParams(filters).toString(),
    [filters],
  );

  return { filters, today, setFilters, toQueryString };
}
