"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * The Infrastructure tab (spec §8).
 *
 * "Volume, bounces and reply rate broken down by sending inbox, by domain, and
 * by email provider. Problem accounts surfaced by bounce rate, so a single bad
 * inbox can be spotted before it drags a campaign down."
 *
 * The problem-account panel sits above the breakdowns rather than below them,
 * because it is the only part of this page anyone needs to act on today.
 */

type View = "inbox" | "domain" | "provider";

interface Totals {
  inboxes: number;
  sending: number;
  domains: number;
  providers: number;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
}

interface InboxRow {
  id: number;
  email: string;
  name: string | null;
  domain: string | null;
  provider: string | null;
  status: string | null;
  daily_limit: number | null;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
}

interface GroupRow {
  label: string;
  inboxes: number;
  sent: number;
  bounced: number;
  replied: number;
  bounce_rate: number | null;
  reply_rate: number | null;
}

interface Response {
  view: View;
  totals: Totals | null;
  rows: Array<InboxRow | GroupRow>;
  total: number;
  problems: InboxRow[];
  minSent: number;
}

/*
 * Bounce-rate tone. The thresholds are deliberately conservative for cold
 * email: sustained bounce above ~3% is what gets a domain reputation-flagged,
 * and 2% is where it is worth looking before it becomes 3%.
 */
function bounceTone(rate: number | null): string {
  if (rate == null) return "";
  if (rate >= 0.03) return "text-red-700 font-medium";
  if (rate >= 0.02) return "text-amber-700";
  return "";
}

export function InfrastructureView() {
  const [view, setView] = useState<View>("inbox");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("sent");

  const { data, isFetching } = useQuery<Response>({
    queryKey: ["infrastructure", view, search, sort],
    queryFn: async () => {
      const params = new URLSearchParams({ view, sort });
      if (search) params.set("q", search);
      const response = await fetch(`/api/infrastructure?${params}`);
      if (!response.ok) throw new Error("Could not load the sending estate");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const totals = data?.totals;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-6">
        <h1 className="text-sm font-medium">Infrastructure</h1>
        {totals ? (
          <span className="tnum text-xs text-muted-foreground">
            {fullNumber(totals.sending)} of {fullNumber(totals.inboxes)} inboxes sending ·{" "}
            {fullNumber(totals.domains)} domains
          </span>
        ) : null}
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="max-w-5xl space-y-6">
          {totals ? (
            <section className="grid grid-cols-2 divide-x divide-y border sm:grid-cols-4">
              {(
                [
                  ["Sent", compactNumber(totals.sent), ""],
                  ["Bounced", compactNumber(totals.bounced), ""],
                  ["Bounce rate", percent(totals.bounce_rate, 2), bounceTone(totals.bounce_rate)],
                  ["Reply rate", percent(totals.reply_rate, 2), ""],
                ] as const
              ).map(([label, value, tone]) => (
                <div key={label} className="p-3">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    {label}
                  </p>
                  <p className={cn("tnum mt-0.5 text-lg", tone)}>{value}</p>
                </div>
              ))}
            </section>
          ) : null}

          {/*
            * Two caveats, both stated rather than discovered.
            *
            * The date range sits directly above this table and does NOT apply
            * to it — per-inbox figures are only available as lifetime counters
            * (per-day would cost one API call per inbox, i.e. 1,470 a night).
            * A filter that visibly does nothing is worse than no filter.
            */}
          <p className="rounded-md border bg-muted/30 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
            <strong className="text-foreground">These figures are lifetime</strong> — they do
            not respond to the date range above. EmailBison reports per-inbox performance only
            as running totals. They also will not match the campaign totals in Analytics
            exactly ({compactNumber(totals?.sent ?? null)} here): warm-up sends and inboxes
            attached to deleted campaigns are counted on this page but not there.
          </p>

          {data?.problems?.length ? (
            <section>
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <AlertTriangle className="size-3.5 text-amber-600" />
                Problem accounts
                <span className="normal-case tracking-normal text-muted-foreground/70">
                  — worst bounce rate, {data.minSent}+ sends
                </span>
              </h2>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <tbody className="divide-y">
                    {data.problems.map((row) => (
                      <tr key={row.id} className="hover:bg-accent/40">
                        <td className="max-w-0 px-3 py-1.5">
                          <span className="block truncate" title={row.email}>
                            {row.email}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">{row.status}</td>
                        <td className="tnum px-3 py-1.5 text-right">{fullNumber(row.sent)}</td>
                        <td
                          className={cn(
                            "tnum px-3 py-1.5 text-right",
                            bounceTone(row.bounce_rate),
                          )}
                        >
                          {percent(row.bounce_rate, 2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-md border p-0.5">
                {(
                  [
                    ["inbox", "By inbox"],
                    ["domain", "By domain"],
                    ["provider", "By provider"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setView(key)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs transition-colors",
                      view === key
                        ? "bg-accent font-medium text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {view === "inbox" ? (
                <>
                  <div className="relative min-w-[180px] flex-1 max-w-xs">
                    <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search inbox or domain…"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    aria-label="Sort inboxes"
                    className="h-8 rounded-md border bg-background px-2 text-xs"
                  >
                    <option value="sent">Most sent</option>
                    <option value="bounce_rate">Worst bounce rate</option>
                    <option value="reply_rate">Best reply rate</option>
                  </select>
                  <span className="tnum ml-auto text-xs text-muted-foreground">
                    {fullNumber(data?.total ?? 0)} inboxes
                  </span>
                </>
              ) : null}
            </div>

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">
                      {view === "inbox" ? "Inbox" : view === "domain" ? "Domain" : "Provider"}
                    </th>
                    {view === "inbox" ? (
                      <>
                        <th className="px-3 py-2 font-medium">Provider</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </>
                    ) : (
                      <th className="px-3 py-2 text-right font-medium">Inboxes</th>
                    )}
                    <th className="px-3 py-2 text-right font-medium">Sent</th>
                    <th className="px-3 py-2 text-right font-medium">Bounce %</th>
                    <th className="px-3 py-2 text-right font-medium">Reply %</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data?.rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-muted-foreground">
                        Nothing to show. Run sync-senders if this is unexpected.
                      </td>
                    </tr>
                  ) : (
                    data?.rows.map((row, i) => {
                      const inbox = view === "inbox" ? (row as InboxRow) : null;
                      const group = inbox ? null : (row as GroupRow);
                      return (
                        <tr key={inbox?.id ?? group?.label ?? i} className="hover:bg-accent/40">
                          <td className="max-w-0 px-3 py-1.5">
                            <span
                              className="block truncate"
                              title={inbox?.email ?? group?.label}
                            >
                              {inbox?.email ?? group?.label}
                            </span>
                          </td>
                          {inbox ? (
                            <>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {inbox.provider ?? "—"}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {inbox.status ?? "—"}
                              </td>
                            </>
                          ) : (
                            <td className="tnum px-3 py-1.5 text-right text-muted-foreground">
                              {fullNumber(group?.inboxes)}
                            </td>
                          )}
                          <td className="tnum px-3 py-1.5 text-right">
                            {fullNumber(row.sent)}
                          </td>
                          <td
                            className={cn(
                              "tnum px-3 py-1.5 text-right",
                              bounceTone(row.bounce_rate),
                            )}
                          >
                            {percent(row.bounce_rate, 2)}
                          </td>
                          <td className="tnum px-3 py-1.5 text-right">
                            {percent(row.reply_rate, 2)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
