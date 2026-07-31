"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { fullNumber } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * The sending forecast (spec §10) — its own screen, grouped by client with
 * per-client totals.
 *
 * This is the only view in the product that reads live from EmailBison rather
 * than the cache, because a forecast is about what it intends to do next and
 * nothing in Supabase knows that.
 */

const DAYS = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "day_after_tomorrow", label: "Day after" },
] as const;

interface ScheduleResponse {
  day: string;
  error: string | null;
  total: number;
  campaignCount: number;
  groups: Array<{
    clientId: string | null;
    name: string;
    total: number;
    rows: Array<{ campaignId: number; name: string; status: string; emails: number }>;
  }>;
}

export function ScheduleView() {
  const [day, setDay] = useState<(typeof DAYS)[number]["key"]>("today");

  const { data, isFetching } = useQuery<ScheduleResponse>({
    queryKey: ["schedule", day],
    queryFn: async () => {
      const response = await fetch(`/api/schedule?day=${day}`);
      if (!response.ok) throw new Error("Could not load the sending schedule");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <h1 className="text-sm font-medium">Sending schedule</h1>
        {data ? (
          <span className="tnum text-xs text-muted-foreground">
            {fullNumber(data.total)} emails · {data.campaignCount} campaigns
          </span>
        ) : null}
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </header>

      <div className="shrink-0 border-b px-6 py-2.5">
        <div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
          {DAYS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDay(d.key)}
              className={cn(
                "rounded px-3 py-1 text-xs transition-colors",
                day === d.key
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {/*
         * §10: "If a client's schedule can't be retrieved, that's shown against
         * that client rather than silently omitted." An empty forecast and a
         * failed fetch look identical, and they mean opposite things.
         */}
        {data?.error ? (
          <p className="mb-4 flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The schedule could not be retrieved from EmailBison, so this is not a complete
              forecast: {data.error}
            </span>
          </p>
        ) : null}

        {!data ? null : data.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {data.error
              ? "No schedule data was returned."
              : "Nothing is scheduled to send on this day."}
          </p>
        ) : (
          <div className="max-w-3xl space-y-4">
            {data.groups.map((group) => (
              <section key={group.clientId ?? "unassigned"} className="rounded-lg border">
                <header className="flex items-baseline justify-between border-b bg-muted/40 px-3 py-2">
                  <h2
                    className={cn(
                      "text-xs font-medium",
                      group.clientId === null && "text-muted-foreground italic",
                    )}
                  >
                    {group.name}
                  </h2>
                  <span className="tnum text-xs">
                    {fullNumber(group.total)}
                    <span className="ml-1 text-muted-foreground">emails</span>
                  </span>
                </header>
                <ul className="divide-y">
                  {group.rows.map((row) => (
                    <li
                      key={row.campaignId}
                      className="flex items-center gap-3 px-3 py-1.5 text-xs"
                    >
                      <Link
                        href={`/campaigns/${row.campaignId}`}
                        className="min-w-0 flex-1 truncate hover:underline"
                        title={row.name}
                      >
                        {row.name}
                      </Link>
                      <span className="shrink-0 text-muted-foreground">{row.status}</span>
                      <span className="tnum w-20 shrink-0 text-right">
                        {fullNumber(row.emails)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
