"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ColumnPicker, useColumnPrefs } from "@/components/analytics/column-picker";
import { SortableHeader } from "@/components/analytics/sortable-header";
import { useTableSort } from "@/hooks/use-table-sort";
import {
  LEAD_COLUMNS,
  LEAD_COLUMN_GROUPS,
  LEAD_COLUMN_PREFS_KEY,
  LEAD_COLUMN_PREFS_VERSION,
  LEAD_DEFAULT_VISIBLE,
  LEAD_STATUS_LABELS,
  type LeadRow,
} from "@/lib/analytics/lead-columns.ts";
import { fullNumber } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * Who this campaign has actually contacted.
 *
 * Read-only. Leads are added in EmailBison; this answers "who is in it, how far
 * did each get, and what came back" — which nothing in the product could answer
 * before, because lead→campaign membership was not recorded anywhere.
 *
 * NO DATE RANGE. The campaign page has no filter bar, and membership is a
 * lifetime fact — a range here would quietly imply a lead outside it was never
 * contacted.
 *
 * Everything is server-side: search, status filter, sort and paging. A campaign
 * has thousands of leads and a `.select()` truncates at 1,000 rows in silence.
 */

const STATUS_TONE: Record<string, string> = {
  positive: "bg-emerald-100 text-emerald-800",
  replied: "bg-blue-100 text-blue-800",
  bounced: "bg-red-100 text-red-800",
  completed: "bg-muted text-muted-foreground",
  contacted: "bg-muted text-muted-foreground",
};

interface Response {
  rows: LeadRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: Array<{ status: string; leads: number }>;
}

export function CampaignLeads({ campaignId }: { campaignId: number }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const { visible, setVisible } = useColumnPrefs(
    LEAD_COLUMN_PREFS_KEY,
    LEAD_COLUMN_PREFS_VERSION,
    LEAD_DEFAULT_VISIBLE,
  );
  const { sort, toggle } = useTableSort();

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  /*
   * Page derived during render, not reset from an effect. The React Compiler
   * lint rejects setState in an effect, and it would render the stale page once
   * before correcting — see range-picker.tsx.
   */
  const filterKey = `${debounced}|${status}|${sort?.key ?? ""}|${sort?.dir ?? ""}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;

  const params = new URLSearchParams({ page: String(page) });
  if (debounced) params.set("q", debounced);
  if (status) params.append("status", status);
  if (sort) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }

  const { data, isFetching, isLoading } = useQuery<Response>({
    queryKey: ["campaign-leads", campaignId, params.toString()],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${campaignId}/leads?${params}`);
      if (!response.ok) throw new Error("Could not load leads");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const columns = LEAD_COLUMNS.filter((c) => visible.includes(c.key));
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));
  const facetTotal = (data?.facets ?? []).reduce((n, f) => n + Number(f.leads), 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or company…"
            className="h-8 pl-9 text-sm"
          />
        </div>

        {/* Counts on the chips, so "how many bounced" is answered without
            clicking through each one. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStatus(null)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              status === null ? "border-foreground/25 bg-accent" : "hover:bg-accent/50",
            )}
          >
            All {facetTotal ? fullNumber(facetTotal) : ""}
          </button>
          {(data?.facets ?? []).map((f) => (
            <button
              key={f.status}
              type="button"
              onClick={() => setStatus(status === f.status ? null : f.status)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                status === f.status ? "border-foreground/25 bg-accent" : "hover:bg-accent/50",
              )}
            >
              {LEAD_STATUS_LABELS[f.status] ?? f.status} {fullNumber(Number(f.leads))}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {isFetching ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
          <ColumnPicker
            visible={visible}
            onChange={setVisible}
            columns={LEAD_COLUMNS}
            groups={LEAD_COLUMN_GROUPS}
          />
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border p-10 text-center text-sm text-muted-foreground">
          Loading leads…
        </div>
      ) : total === 0 ? (
        <div className="rounded-xl border p-10 text-center text-sm text-muted-foreground">
          {debounced || status
            ? "No leads match that."
            : "No leads recorded for this campaign yet. Membership is built from the send history, which syncs every three hours."}
        </div>
      ) : (
        <>
          {/* The identity column stays pinned so a row never loses its person
              while scrolling sideways — same shell as the Campaigns table. */}
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="sticky left-0 z-20 min-w-[260px] bg-muted/30 px-3 py-2 text-left font-medium">
                    Lead
                  </th>
                  {columns.map((c) => (
                    <SortableHeader
                      key={c.key}
                      label={c.label}
                      sortKey={c.sortKey}
                      align={c.align ?? "right"}
                      sort={sort}
                      onToggle={toggle}
                    />
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.leadId} className="hover:bg-accent/30">
                    <td className="sticky left-0 z-10 min-w-[260px] bg-background px-3 py-2">
                      <span className="block truncate font-medium">
                        {row.name || row.email || `Lead #${row.leadId}`}
                      </span>
                      {row.name ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.email}
                        </span>
                      ) : null}
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cn(
                          "tnum whitespace-nowrap px-3 py-2",
                          (c.align ?? "right") === "right" ? "text-right" : "text-left",
                        )}
                      >
                        {c.key === "status" ? (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[11px] font-medium",
                              STATUS_TONE[row.status] ?? "bg-muted",
                            )}
                          >
                            {LEAD_STATUS_LABELS[row.status] ?? row.status}
                          </span>
                        ) : (
                          c.render(row)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="tnum">
              {fullNumber((page - 1) * (data?.pageSize ?? 50) + 1)}–
              {fullNumber(Math.min(page * (data?.pageSize ?? 50), total))} of {fullNumber(total)}
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPageState({ key: filterKey, page: page - 1 })}
                className="rounded border p-1 disabled:opacity-40"
                aria-label="Previous page"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="tnum">
                {page} / {pages}
              </span>
              <button
                type="button"
                disabled={page >= pages}
                onClick={() => setPageState({ key: filterKey, page: page + 1 })}
                className="rounded border p-1 disabled:opacity-40"
                aria-label="Next page"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
