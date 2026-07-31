"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAnalyticsFilters } from "./filters-context";
import {
  compactNumber,
  duration,
  fullNumber,
  percent,
  ratio,
} from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

interface ClientRow {
  clientId: string | null;
  name: string;
  campaignCount: number;
  ambiguousCount: number;
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  positive: number;
  bounces: number;
  replyRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
  medianReplySeconds: number | null;
}

interface Response {
  rows: ClientRow[];
  totals: Record<string, number>;
  count: number;
}

type SortKey = keyof Pick<
  ClientRow,
  "sent" | "prospects" | "replies" | "positive" | "bounces" | "replyRate" | "positiveRate"
>;

/*
 * Per-client rollup. Values use fullNumber (exact, comparable down a column),
 * not the KPI band's compact form -- a table is for comparing rows, and
 * `20.2K` vs `17.6K` hides the difference that `20,224` vs `17,612` shows.
 */
export function ClientsView() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("sent");

  const query = useQuery<Response>({
    queryKey: ["clients", qs],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/clients${qs ? `?${qs}` : ""}`);
      if (!response.ok) throw new Error("Failed to load clients");
      return response.json();
    },
  });

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    const filtered = search
      ? all.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
      : all;
    return [...filtered].sort((a, b) => (b[sort] ?? 0) - (a[sort] ?? 0));
  }, [query.data, search, sort]);

  const totals = query.data?.totals;

  const columns: Array<{ key: SortKey | null; label: string; render: (r: ClientRow) => string }> = [
    { key: "sent", label: "Sent", render: (r) => fullNumber(r.sent) },
    { key: "prospects", label: "Prospects", render: (r) => fullNumber(r.prospects) },
    { key: "replies", label: "Replies", render: (r) => fullNumber(r.replies) },
    { key: "positive", label: "Positive", render: (r) => fullNumber(r.positive) },
    { key: "replyRate", label: "Reply %", render: (r) => percent(r.replyRate, 2) },
    { key: "positiveRate", label: "Positive %", render: (r) => percent(r.positiveRate, 2) },
    { key: null, label: "Email/Lead", render: (r) => ratio(r.leadToEmail) },
    { key: "bounces", label: "Bounces", render: (r) => fullNumber(r.bounces) },
    { key: null, label: "Median Reply", render: (r) => duration(r.medianReplySeconds) },
  ];

  if (query.isLoading) return <Skeleton className="h-72 w-full" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {query.data?.count ?? 0} {query.data?.count === 1 ? "client" : "clients"}
        </p>
        <div className="relative w-56">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clients…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b bg-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="sticky left-0 z-10 bg-muted/30 px-3 py-2 text-left font-medium">
                Client
              </th>
              {columns.map((c) => (
                <th key={c.label} className="px-3 py-2 text-right font-medium">
                  {c.key ? (
                    <button
                      type="button"
                      onClick={() => setSort(c.key!)}
                      className={cn(
                        "transition-colors hover:text-foreground",
                        sort === c.key && "text-foreground",
                      )}
                    >
                      {c.label}
                      {sort === c.key ? " ↓" : ""}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {rows.map((r) => (
              <tr
                key={r.clientId ?? "unassigned"}
                className={cn(
                  "border-b last:border-b-0 hover:bg-accent/40",
                  // Unassigned is a real row, never hidden: without it the
                  // column totals would silently fall short of the KPI band.
                  !r.clientId && "bg-amber-50/50",
                )}
              >
                <td className="sticky left-0 z-10 bg-background px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate", !r.clientId && "text-amber-700")}>
                      {r.name}
                    </span>
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {r.campaignCount}
                    </span>
                    {r.ambiguousCount > 0 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
                        </TooltipTrigger>
                        <TooltipContent>
                          {r.ambiguousCount} campaign
                          {r.ambiguousCount === 1 ? "" : "s"} matched more than one
                          client
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                </td>
                {columns.map((c) => (
                  <td key={c.label} className="tnum px-3 py-2.5 text-right">
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Totals band. Summed from the rendered rows, so it always agrees with
          the table -- and, because Unassigned is included, with the KPI band. */}
      {totals ? (
        <div className="grid grid-cols-2 divide-x divide-[--hairline] rounded-lg border sm:grid-cols-3 lg:grid-cols-6">
          {[
            ["Total Sent", totals.sent],
            ["Prospects", totals.prospects],
            ["Replies", totals.replies],
            ["Human", totals.humanReplies],
            ["Positive", totals.positive],
            ["Bounces", totals.bounces],
          ].map(([label, value]) => (
            <div key={String(label)} className="px-4 py-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="tnum mt-0.5 text-lg font-semibold">
                {compactNumber(Number(value))}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
