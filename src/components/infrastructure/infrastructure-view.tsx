"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * The Infrastructure tab (spec §8).
 *
 * Rewritten after the first version proved unreadable. Three faults, worth
 * naming because they are easy to reintroduce:
 *
 *  1. The inbox column was `max-w-0` + truncate, so every row rendered as
 *     "nicole.c@real…". Across 1,470 near-identical addresses that is not a
 *     shortened label, it is no label — no two rows could be told apart. The
 *     DOMAIN is what carries meaning here (one persona sends from hundreds of
 *     domains, and reputation attaches to the domain), so it gets its own
 *     column, first, with the width to show it in full.
 *  2. The problem-accounts table had no header row: two bare numbers per line
 *     and no way to know which was which.
 *  3. The page was capped at max-w-5xl on a 2000px screen, so everything fought
 *     for space in the left third while two thirds sat empty.
 *
 * Bounce rate is the only number here anyone acts on, so it gets a meter — a
 * ratio against a limit, which is what a meter is for. Colour never carries the
 * status alone: every toned bar is accompanied by a text chip, because a status
 * hue must ship with a label.
 */

type View = "domain" | "provider" | "inbox";

/*
 * Cold-email thresholds. Sustained bounce above 3% is what gets a sending
 * domain reputation-flagged; 2% is where it is worth looking before it becomes
 * 3%. The meter is scaled to 5% so the danger zone occupies the top of the
 * track instead of pinning every bar to full.
 */
const WATCH = 0.02;
const HIGH = 0.03;
const METER_CEILING = 0.05;

/*
 * Reserved status hues, never reused as series colours — and healthy rows are
 * deliberately GREY, not green.
 *
 * This is the emphasis principle: the problem rows are the point, the other 400
 * are context. Toning every healthy bar green produced a wall of colour that
 * buried the handful of rows worth acting on. Grey context, coloured exception.
 */
const STATUS = {
  high: { fill: "#d03b3b", label: "high", chip: "bg-red-100 text-red-900" },
  watch: { fill: "#fab219", label: "watch", chip: "bg-amber-100 text-amber-900" },
  ok: { fill: "var(--color-muted-foreground)", label: "", chip: "" },
} as const;

function statusOf(rate: number | null | undefined) {
  if (rate == null) return null;
  if (rate >= HIGH) return STATUS.high;
  if (rate >= WATCH) return STATUS.watch;
  return STATUS.ok;
}

/** `google_workspace_oauth` is a machine name, not something to read in a table. */
function providerLabel(provider: string | null): string {
  if (!provider) return "—";
  return (
    {
      google_workspace_oauth: "Google Workspace",
      microsoft_oauth: "Microsoft 365",
      custom: "Custom SMTP",
      smtp: "SMTP",
    }[provider] ?? provider.replace(/_/g, " ")
  );
}

interface Totals {
  inboxes: number; sending: number; domains: number; providers: number;
  sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface InboxRow {
  id: number; email: string; name: string | null; domain: string | null;
  provider: string | null; status: string | null; daily_limit: number | null;
  sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface GroupRow {
  label: string; inboxes: number; sent: number; bounced: number; replied: number;
  bounce_rate: number | null; reply_rate: number | null;
}
interface Response {
  view: View; totals: Totals | null;
  rows: Array<InboxRow | GroupRow>; total: number;
  problems: InboxRow[]; minSent: number;
}

/** A ratio against a limit, with the 3% threshold marked on the track. */
function BounceMeter({ rate }: { rate: number | null }) {
  const status = statusOf(rate);
  if (rate == null || !status) return <span className="text-muted-foreground">–</span>;
  const width = Math.min(rate / METER_CEILING, 1) * 100;

  /*
   * Order is chip → bar → value, with the value last and fixed-width, so the
   * numbers form one clean right-aligned column down the table. Putting the bar
   * last left the digits ragged and pushed the meter off the edge.
   */
  return (
    <span className="flex items-center justify-end gap-2.5">
      {status.label ? (
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            status.chip,
          )}
        >
          {status.label}
        </span>
      ) : null}
      <span
        className="relative hidden h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted md:block"
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full opacity-90"
          style={{ width: `${width}%`, backgroundColor: status.fill }}
        />
        {/* The 3% line, so a bar reads against the threshold rather than only
            against its neighbours. */}
        <span
          className="absolute inset-y-0 w-px bg-foreground/30"
          style={{ left: `${(HIGH / METER_CEILING) * 100}%` }}
        />
      </span>
      <span className={cn("tnum w-14 text-right", status.label && "font-medium")}>
        {percent(rate, 2)}
      </span>
    </span>
  );
}

export function InfrastructureView() {
  const [view, setView] = useState<View>("domain");
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
  const problems = data?.problems ?? [];

  /*
   * Render from the shape the rows ACTUALLY have, not from the toggle's state.
   *
   * `keepPreviousData` deliberately holds the previous view's rows on screen
   * while the new ones load — but `view` flips instantly, so for one render the
   * component was reading domain rows as inbox rows and calling .split() on an
   * `email` that isn't there. That crashed the whole tab with a client-side
   * exception, not a blank table.
   *
   * The response echoes the view it was built for; that is the authority for
   * how to draw a row. The buttons still track `view` so the UI stays
   * responsive to the click.
   */
  const rowsView = data?.view ?? view;
  const highCount = problems.filter((p) => (p.bounce_rate ?? 0) >= HIGH).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-6">
        <h1 className="text-sm font-medium">Infrastructure</h1>
        {totals ? (
          <p className="tnum text-xs text-muted-foreground">
            {fullNumber(totals.sending)} of {fullNumber(totals.inboxes)} inboxes sending ·{" "}
            {fullNumber(totals.domains)} domains
          </p>
        ) : null}
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </header>

      {/* Hairline grid, no cards — the same treatment as the Campaign KPI band. */}
      {totals ? (
        <section className="grid shrink-0 grid-cols-2 divide-x border-b sm:grid-cols-4">
          {(
            [
              ["Sent", compactNumber(totals.sent), null],
              ["Bounced", compactNumber(totals.bounced), null],
              ["Bounce rate", percent(totals.bounce_rate, 2), statusOf(totals.bounce_rate)],
              ["Reply rate", percent(totals.reply_rate, 2), null],
            ] as const
          ).map(([label, value, status]) => (
            <div key={label} className="px-6 py-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {label}
              </p>
              <p className="tnum mt-1 flex items-baseline gap-2 text-xl">
                {value}
                {status?.label ? (
                  <span
                    className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", status.chip)}
                  >
                    {status.label}
                  </span>
                ) : null}
              </p>
            </div>
          ))}
        </section>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {/*
          * Capped rather than full-bleed. Seven columns across 2000px opened a
          * dead zone between the domain and its numbers, and the eye has to
          * travel the whole width to connect a row's name to its bounce rate.
          * ~1440px keeps that scan short while leaving the name column room to
          * show a domain in full — which was the original fault.
          */}
        <div className="max-w-[1440px] space-y-6">
          {problems.length ? (
            <section>
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <h2 className="text-xs font-medium uppercase tracking-wider">Needs attention</h2>
                <p className="text-xs text-muted-foreground">
                  {highCount > 0
                    ? `${highCount} inbox${highCount === 1 ? "" : "es"} at or above ${percent(HIGH, 0)} bounce`
                    : "Worst bounce rates"}{" "}
                  · {data?.minSent}+ sends
                </p>
              </div>

              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Domain</th>
                      <th className="w-48 px-3 py-2 font-medium">Mailbox</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Sent</th>
                      <th className="w-24 px-3 py-2 text-right font-medium">Bounced</th>
                      <th className="w-64 px-3 py-2 text-right font-medium">Bounce rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {problems.map((row) => (
                      <tr key={row.id} className="hover:bg-accent/40">
                        {/* Domain first and unshortened: it is what differs
                            between these rows, and what reputation attaches to. */}
                        <td className="px-3 py-1.5 font-medium">{row.domain ?? "—"}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {row.email?.split("@")[0] ?? "—"}
                        </td>
                        <td className="tnum px-3 py-1.5 text-right">{fullNumber(row.sent)}</td>
                        <td className="tnum px-3 py-1.5 text-right text-muted-foreground">
                          {fullNumber(row.bounced)}
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <BounceMeter rate={row.bounce_rate} />
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
                    ["domain", "By domain"],
                    ["provider", "By provider"],
                    ["inbox", "By inbox"],
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
                  <div className="relative min-w-[200px] max-w-xs flex-1">
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
                </>
              ) : null}

              <p className="tnum ml-auto text-xs text-muted-foreground">
                {rowsView === "inbox"
                  ? `${fullNumber(data?.total ?? 0)} inboxes`
                  : `${fullNumber(data?.rows.length ?? 0)} ${rowsView === "domain" ? "domains" : "providers"}`}
              </p>
            </div>

            <div className="overflow-hidden rounded-lg border">
              <table className="w-full text-xs">
                <thead className="border-b bg-muted/40 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr>
                    {rowsView === "inbox" ? (
                      <>
                        <th className="px-3 py-2 font-medium">Domain</th>
                        <th className="w-44 px-3 py-2 font-medium">Mailbox</th>
                        <th className="w-40 px-3 py-2 font-medium">Provider</th>
                      </>
                    ) : (
                      <>
                        <th className="px-3 py-2 font-medium">
                          {rowsView === "domain" ? "Domain" : "Provider"}
                        </th>
                        <th className="w-24 px-3 py-2 text-right font-medium">Inboxes</th>
                      </>
                    )}
                    <th className="w-24 px-3 py-2 text-right font-medium">Sent</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Replies</th>
                    <th className="w-24 px-3 py-2 text-right font-medium">Reply %</th>
                    <th className="w-64 px-3 py-2 text-right font-medium">Bounce rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {!data?.rows.length ? (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-muted-foreground">
                        Nothing to show. Run sync-senders if this is unexpected.
                      </td>
                    </tr>
                  ) : (
                    data.rows.map((row, i) => {
                      const inbox = rowsView === "inbox" ? (row as InboxRow) : null;
                      const group = inbox ? null : (row as GroupRow);
                      return (
                        <tr key={inbox?.id ?? group?.label ?? i} className="hover:bg-accent/40">
                          {inbox ? (
                            <>
                              <td className="px-3 py-1.5 font-medium">{inbox.domain ?? "—"}</td>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {inbox.email?.split("@")[0] ?? "—"}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {providerLabel(inbox.provider)}
                                {/* Status only when it is NOT the norm — 1,470
                                    rows reading "Connected" is not information. */}
                                {inbox.status && inbox.status !== "Connected" ? (
                                  <span className="ml-1.5 rounded bg-amber-100 px-1 text-[10px] text-amber-900">
                                    {inbox.status}
                                  </span>
                                ) : null}
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="px-3 py-1.5 font-medium">
                                {rowsView === "provider" ? providerLabel(group!.label) : group!.label}
                              </td>
                              <td className="tnum px-3 py-1.5 text-right text-muted-foreground">
                                {fullNumber(group!.inboxes)}
                              </td>
                            </>
                          )}
                          <td className="tnum px-3 py-1.5 text-right">{fullNumber(row.sent)}</td>
                          <td className="tnum px-3 py-1.5 text-right text-muted-foreground">
                            {fullNumber(row.replied)}
                          </td>
                          <td className="tnum px-3 py-1.5 text-right">
                            {percent(row.reply_rate, 2)}
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <BounceMeter rate={row.bounce_rate} />
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/*
            * Demoted to a footnote. It used to sit above the data, so the first
            * thing the page said was a caveat — but it still has to be said:
            * the date range in the filter bar does not apply here, and a filter
            * that visibly does nothing is worse than no filter.
            */}
          <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            <strong className="font-medium text-foreground">Lifetime figures.</strong> These do
            not respond to the date range above — EmailBison reports per-inbox performance only
            as running totals. They also will not match the campaign totals in Analytics
            exactly: warm-up sends and inboxes attached to deleted campaigns count here but not
            there.
          </p>
        </div>
      </div>
    </div>
  );
}
