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
 * reopened exactly.
 *
 * `push`, NOT `replace`, and the comment here used to claim both at once: it
 * said the back button steps through filter changes and then used replace,
 * which creates no history entry — so back left the page entirely, which is
 * precisely what §3 says it must not do.
 *
 * The stated reason for replace was "you don't want twelve history entries from
 * dragging a date range", and that fear is obsolete: the range picker commits
 * on Apply (§3: "nothing reloads until you do"), so dragging produces no
 * navigation at all. Every remaining caller is a deliberate click — a pill, a
 * checkbox, a chip — and one history entry per deliberate choice is exactly
 * what "step back through your filter changes" means.
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
      router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [filters, pathname, router],
  );

  const toQueryString = useCallback(
    () => filtersToSearchParams(filters).toString(),
    [filters],
  );

  return { filters, today, setFilters, toQueryString };
}
