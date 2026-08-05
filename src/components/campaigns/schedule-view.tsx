"use client";

import { useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { SyncButton } from "@/components/analytics/sync-button";
import { cn } from "@/lib/utils";

/*
 * The sending forecast (spec §10) — its own screen, grouped by client with
 * per-client totals.
 *
 * This is the only view in the product that reads live from EmailBison rather
 * than the cache, because a forecast is about what it intends to do next and
 * nothing in Supabase knows that.
 *
 * ALL THREE DAYS ARE FETCHED, not just the selected one, and that is what makes
 * the day picker worth having. A forecast answers "what goes out today"; the
 * question immediately after is "and is that normal?" — which a control that
 * shows one number at a time cannot answer. With each day's total on its own
 * segment, a drop from 8,127 to 400 is visible before you click it. It costs
 * ~2 EmailBison calls per day, cached for a minute.
 */

const DAYS = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "day_after_tomorrow", label: "Day after" },
] as const;

type DayKey = (typeof DAYS)[number]["key"];

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
  const [day, setDay] = useState<DayKey>("today");

  const results = useQueries({
    queries: DAYS.map((d) => ({
      queryKey: ["schedule", d.key],
      queryFn: async (): Promise<ScheduleResponse> => {
        const response = await fetch(`/api/schedule?day=${d.key}`);
        if (!response.ok) throw new Error("Could not load the sending schedule");
        return response.json();
      },
      placeholderData: keepPreviousData,
      staleTime: 60_000,
    })),
  });

  const byDay = Object.fromEntries(
    DAYS.map((d, i) => [d.key, results[i]]),
  ) as Record<DayKey, (typeof results)[number]>;

  const active = byDay[day];
  const data = active.data;
  const isFetching = results.some((r) => r.isFetching);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-6 py-2">
        <h1 className="text-sm font-medium">Sending schedule</h1>
        {data ? (
          <span className="tnum text-xs text-muted-foreground">
            {fullNumber(data.total)} emails · {data.campaignCount} campaigns ·{" "}
            {data.groups.length} {data.groups.length === 1 ? "client" : "clients"}
          </span>
        ) : null}
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}

        {/*
          The forecast itself is always live, but the campaign NAMES and the
          client grouping come from the cache — so a campaign created in
          EmailBison since the last entity sync appears here as "Campaign
          #1284", unnamed and unassigned. This syncs the entities and then
          re-reads all three days.
        */}
        <div className="ml-auto">
          <SyncButton label="Sync schedule" invalidate={["schedule"]} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1800px] space-y-5 p-6">
          {/*
            The picker IS the comparison. Each segment carries its own day's
            total, so the shape of the next three days is readable without
            clicking through them one at a time.
          */}
          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {DAYS.map((d) => {
              const result = byDay[d.key];
              const selected = day === d.key;
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDay(d.key)}
                  aria-pressed={selected}
                  className={cn(
                    "rounded-xl border p-3 text-left transition-colors",
                    selected
                      ? "border-foreground/25 bg-card shadow-sm"
                      : "bg-card/40 hover:border-foreground/15 hover:bg-card",
                  )}
                >
                  <p
                    className={cn(
                      "text-xs",
                      selected ? "font-medium text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {d.label}
                  </p>
                  <p className="tnum mt-1 text-2xl font-semibold tracking-tight">
                    {result.data ? compactNumber(result.data.total) : "—"}
                  </p>
                  <p className="tnum text-[11px] text-muted-foreground">
                    {result.data
                      ? `${result.data.campaignCount} campaigns`
                      : result.isError
                        ? "could not load"
                        : "loading…"}
                  </p>
                </button>
              );
            })}
          </div>

          {/*
           * §10: "If a client's schedule can't be retrieved, that's shown against
           * that client rather than silently omitted." An empty forecast and a
           * failed fetch look identical, and they mean opposite things.
           */}
          {data?.error ? (
            <p className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 p-2.5 text-xs text-amber-900">
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
            <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {data.groups.map((group) => (
                <ClientCard key={group.clientId ?? "unassigned"} group={group} dayTotal={data.total} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClientCard({
  group,
  dayTotal,
}: {
  group: ScheduleResponse["groups"][number];
  dayTotal: number;
}) {
  const share = dayTotal > 0 ? group.total / dayTotal : null;

  return (
    /* min-w-0: a grid item defaults to min-width:auto, so the longest campaign
       name — "…LPT Realty 2 + Nicole + West Ashley, North Charleston, …" — set
       the card's width and pushed the totals off the right edge of a phone
       instead of truncating. */
    <section className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm">
      <header className="border-b px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <h2
            className={cn(
              "min-w-0 truncate text-sm font-medium",
              group.clientId === null && "italic text-muted-foreground",
            )}
            title={group.name}
          >
            {group.name}
          </h2>
          <span className="tnum shrink-0 text-sm font-semibold">
            {fullNumber(group.total)}
          </span>
        </div>

        {/*
          Share of the day. The absolute number alone doesn't say whether 995 is
          most of the day's sending or a rounding error against it, and that is
          the question a forecast grouped by client is being read for.
        */}
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-[#2a78d6]"
              style={{ width: `${Math.max((share ?? 0) * 100, 1)}%` }}
            />
          </div>
          <span className="tnum shrink-0 text-[11px] text-muted-foreground">
            {percent(share, 1)} of day
          </span>
        </div>
      </header>

      <ul className="divide-y">
        {group.rows.map((row) => (
          <li key={row.campaignId} className="flex items-center gap-2 px-3 py-2 text-xs">
            <Link
              href={`/campaigns/${row.campaignId}`}
              className="min-w-0 flex-1 truncate hover:underline"
              title={row.name}
            >
              {row.name}
            </Link>
            {/*
              Named only when it is NOT active. Every campaign with mail queued
              for today is active, so printing "active" on all 20 rows was pure
              noise — while a paused campaign that is still scheduled to send is
              exactly the thing worth seeing.
            */}
            {row.status !== "active" ? (
              <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
                {row.status}
              </span>
            ) : null}
            <span className="tnum shrink-0 tabular-nums text-right">
              {fullNumber(row.emails)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
