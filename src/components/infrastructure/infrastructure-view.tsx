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
 * Third pass. The first two were about correctness of layout — truncated
 * labels, missing headers, dead space. This one is about how it reads, because
 * even once the mechanics were right it was still a wall of 12px grey text in
 * boxes, and that is a legitimate complaint.
 *
 * What changed, and why each is deliberate:
 *
 *  - CHROME REMOVED. No outer borders around tables, no boxed panels. Grouping
 *    comes from whitespace and a single hairline, so the data is the only thing
 *    drawing ink. Boxes inside boxes are what made it look heavy.
 *  - ROOM TO BREATHE. Rows are 13px on ~40px of height instead of 12px on 26px.
 *    Density was costing legibility for no gain — nobody reads 493 domains, they
 *    scan the top twenty.
 *  - TYPE DOES THE HIERARCHY. Micro uppercase tracking-wider grey headers on
 *    every column read as noise; headers are now plain sentence case, and weight
 *    separates a domain from its numbers.
 *  - THE NUMBER CARRIES THE STATUS. The WATCH/HIGH chips sat mid-row in a
 *    different horizontal position on every line, which is what made the table
 *    look untidy. The bounce value is now toned itself. That is not
 *    colour-alone: the figure states its own magnitude against a threshold
 *    printed in the header, so a reader who cannot see the tone still reads
 *    3.86% and knows it is over 3%.
 *  - FEWER COLUMNS. Reply count went; Reply % is the useful form of it.
 */

type View = "domain" | "provider" | "inbox";

/*
 * Cold-email thresholds. Sustained bounce above 3% is what gets a sending
 * domain reputation-flagged; 2% is worth looking at before it becomes 3%. The
 * meter is scaled to 5% so the danger zone sits at the top of the track rather
 * than pinning every bar to full.
 */
const WATCH = 0.02;
const HIGH = 0.03;
const METER_CEILING = 0.05;

/** Reserved status hues — never reused as series colours. */
const STATUS = {
  high: { bar: "#d03b3b", text: "text-[#b02525]" },
  watch: { bar: "#e0900f", text: "text-[#a16207]" },
  // Mid-grey, not border-grey: recessive next to the toned bars but still
  // clearly a bar. At border tone it vanished into the track and a healthy
  // row looked like a missing one.
  ok: { bar: "#94a3b8", text: "text-foreground" },
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

/** Value + track. The 3% threshold is notched on the track, not just implied. */
function Bounce({ rate }: { rate: number | null }) {
  const status = statusOf(rate);
  if (rate == null || !status) {
    return <span className="text-muted-foreground">–</span>;
  }
  const width = Math.min(rate / METER_CEILING, 1) * 100;

  return (
    <span className="flex items-center justify-end gap-3">
      <span
        className="relative hidden h-[3px] w-24 shrink-0 overflow-hidden rounded-full bg-muted lg:block"
        aria-hidden
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${width}%`, backgroundColor: status.bar }}
        />
        <span
          className="absolute inset-y-0 w-px bg-foreground/20"
          style={{ left: `${(HIGH / METER_CEILING) * 100}%` }}
        />
      </span>
      <span className={cn("tnum w-14 text-right tabular-nums", status.text)}>
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
  const highCount = problems.filter((p) => (p.bounce_rate ?? 0) >= HIGH).length;

  /*
   * Render from the shape the rows ACTUALLY have, not from the toggle's state.
   * keepPreviousData holds the previous view's rows while the next load runs,
   * and `view` flips instantly — reading a domain row as an inbox row crashed
   * the tab. The response echoes the view it was built for; that is the
   * authority for how to draw a row.
   */
  const rowsView = data?.view ?? view;

  const label = { domain: "Domain", provider: "Provider", inbox: "Domain" }[rowsView];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline gap-3 px-8 pb-4 pt-6">
        <h1 className="text-lg font-semibold tracking-tight">Infrastructure</h1>
        {totals ? (
          <p className="tnum text-sm text-muted-foreground">
            {fullNumber(totals.sending)} of {fullNumber(totals.inboxes)} inboxes sending across{" "}
            {fullNumber(totals.domains)} domains
          </p>
        ) : null}
        {isFetching ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </header>

      {/* Stats, unboxed: generous numbers separated by space, not borders. */}
      {totals ? (
        <section className="grid grid-cols-2 gap-y-6 px-8 pb-7 sm:grid-cols-4">
          {(
            [
              ["Sent", compactNumber(totals.sent), null, null],
              [
                "Bounced",
                compactNumber(totals.bounced),
                null,
                // NOT the bounce rate — the tile beside this one already says
                // it. Inbox counts are the fact this tile can add.
                `across ${fullNumber(totals.sending)} sending inboxes`,
              ],
              [
                "Bounce rate",
                percent(totals.bounce_rate, 2),
                statusOf(totals.bounce_rate),
                `${percent(HIGH, 0)} is the danger line`,
              ],
              ["Reply rate", percent(totals.reply_rate, 2), null, null],
            ] as const
          ).map(([name, value, status, hint]) => (
            <div key={name}>
              <p className="text-xs font-medium text-muted-foreground">{name}</p>
              <p
                className={cn(
                  "tnum mt-1.5 text-3xl font-semibold tracking-tight",
                  status?.text,
                )}
              >
                {value}
              </p>
              {hint ? (
                <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-8 pb-8">
        <div className="grid items-start gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,1fr)_300px]">
          <section className="order-2 min-w-0 xl:order-1">
            <div className="flex flex-wrap items-center gap-2 pb-3">
              <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
                {(
                  [
                    ["domain", "Domain"],
                    ["provider", "Provider"],
                    ["inbox", "Inbox"],
                  ] as const
                ).map(([key, text]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setView(key)}
                    className={cn(
                      "rounded-md px-3 py-1 text-[13px] transition-colors",
                      view === key
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {text}
                  </button>
                ))}
              </div>

              {view === "inbox" ? (
                <>
                  <div className="relative min-w-[200px] max-w-xs flex-1">
                    <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search inbox or domain…"
                      className="h-9 rounded-lg pl-9 text-[13px]"
                    />
                  </div>
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value)}
                    aria-label="Sort inboxes"
                    className="h-9 rounded-lg border bg-background px-2.5 text-[13px]"
                  >
                    <option value="sent">Most sent</option>
                    <option value="bounce_rate">Worst bounce rate</option>
                    <option value="reply_rate">Best reply rate</option>
                  </select>
                </>
              ) : null}

              <p className="tnum ml-auto text-[13px] text-muted-foreground">
                {rowsView === "inbox"
                  ? `${fullNumber(data?.total ?? 0)} inboxes`
                  : `${fullNumber(data?.rows.length ?? 0)} ${rowsView === "domain" ? "domains" : "providers"}`}
              </p>
            </div>

            {/*
              * table-fixed: with `auto` the browser hands every spare pixel to
              * the widest text column, so the domain ran to ~1100px while its
              * numbers huddled at the far right. Fixed shares spread the slack.
              */}
            <table className="w-full table-fixed text-[13px]">
              <thead>
                <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                  {rowsView === "inbox" ? (
                    <>
                      <th className="w-[26%] py-2.5 pr-4 font-medium">{label}</th>
                      <th className="w-[14%] py-2.5 pr-4 font-medium">Mailbox</th>
                      <th className="w-[15%] py-2.5 pr-4 font-medium">Provider</th>
                    </>
                  ) : (
                    <>
                      <th className="w-[26%] py-2.5 pr-4 font-medium">{label}</th>
                      <th className="w-[11%] py-2.5 pr-4 text-right font-medium">Inboxes</th>
                    </>
                  )}
                  <th className="w-[12%] py-2.5 pr-4 text-right font-medium">Sent</th>
                  <th className="w-[12%] py-2.5 pr-4 text-right font-medium">Bounced</th>
                  <th className="w-[12%] py-2.5 pr-4 text-right font-medium">Reply&nbsp;%</th>
                  <th className="py-2.5 text-right font-medium">
                    Bounce rate
                    <span className="ml-1.5 font-normal text-muted-foreground/70">
                      · line at {percent(HIGH, 0)}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {!data?.rows.length ? (
                  <tr>
                    <td colSpan={7} className="py-16 text-center text-muted-foreground">
                      Nothing to show. Run sync-senders if this is unexpected.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row, i) => {
                    const inbox = rowsView === "inbox" ? (row as InboxRow) : null;
                    const group = inbox ? null : (row as GroupRow);
                    return (
                      <tr
                        key={inbox?.id ?? group?.label ?? i}
                        className="transition-colors hover:bg-muted/40"
                      >
                        {inbox ? (
                          <>
                            <td
                              className="truncate py-2.5 pr-4 font-medium"
                              title={inbox.domain ?? ""}
                            >
                              {inbox.domain ?? "—"}
                            </td>
                            <td className="truncate py-2.5 pr-4 text-muted-foreground">
                              {inbox.email?.split("@")[0] ?? "—"}
                            </td>
                            <td className="truncate py-2.5 pr-4 text-muted-foreground">
                              {providerLabel(inbox.provider)}
                              {/* Status only when it is NOT the norm — 1,470
                                  rows reading "Connected" is not information. */}
                              {inbox.status && inbox.status !== "Connected" ? (
                                <span className="ml-1.5 rounded bg-amber-100 px-1 text-[11px] text-amber-900">
                                  {inbox.status}
                                </span>
                              ) : null}
                            </td>
                          </>
                        ) : (
                          <>
                            <td
                              className="truncate py-2.5 pr-4 font-medium"
                              title={group!.label}
                            >
                              {rowsView === "provider"
                                ? providerLabel(group!.label)
                                : group!.label}
                            </td>
                            <td className="tnum py-2.5 pr-4 text-right text-muted-foreground">
                              {fullNumber(group!.inboxes)}
                            </td>
                          </>
                        )}
                        <td className="tnum py-2.5 pr-4 text-right">{fullNumber(row.sent)}</td>
                        <td className="tnum py-2.5 pr-4 text-right text-muted-foreground">
                          {fullNumber(row.bounced)}
                        </td>
                        <td className="tnum py-2.5 pr-4 text-right text-muted-foreground">
                          {percent(row.reply_rate, 2)}
                        </td>
                        <td className="py-2.5">
                          <Bounce rate={row.bounce_rate} />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </section>

          {problems.length ? (
            <aside className="order-1 min-w-0 xl:order-2 xl:sticky xl:top-0">
              <div className="pb-3">
                <h2 className="text-[13px] font-medium">Needs attention</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {highCount > 0
                    ? `${highCount} inbox${highCount === 1 ? "" : "es"} over ${percent(HIGH, 0)} bounce`
                    : "Worst bounce rates"}
                  , {data?.minSent}+ sends
                </p>
              </div>

              <ul className="divide-y divide-border/60 border-t border-border/60">
                {problems.map((row) => {
                  const status = statusOf(row.bounce_rate);
                  return (
                    <li
                      key={row.id}
                      className="group flex items-center gap-3 py-2.5 transition-colors hover:bg-muted/40"
                    >
                      {/* A 2px rule instead of a chip: it marks severity without
                          adding a floating badge to every line. */}
                      <span
                        className="h-8 w-0.5 shrink-0 rounded-full"
                        style={{ backgroundColor: status?.bar }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className="block truncate text-[13px] font-medium"
                          title={row.domain ?? ""}
                        >
                          {row.domain ?? "—"}
                        </span>
                        <span className="tnum block truncate text-xs text-muted-foreground">
                          {row.email?.split("@")[0] ?? "—"} · {fullNumber(row.bounced)} of{" "}
                          {fullNumber(row.sent)}
                        </span>
                      </span>
                      <span className={cn("tnum shrink-0 text-[13px] font-medium", status?.text)}>
                        {percent(row.bounce_rate, 2)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </aside>
          ) : null}
        </div>

        {/*
          * A footnote, not a banner. It used to sit above the data so the first
          * thing the page said was a caveat — but it still has to be said: the
          * date range in the filter bar does not apply here, and a filter that
          * visibly does nothing is worse than no filter.
          */}
        <p className="mt-10 max-w-3xl border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-medium text-foreground">Lifetime figures.</strong> These do not
          respond to the date range above — EmailBison reports per-inbox performance only as
          running totals. They also will not match the campaign totals in Analytics exactly:
          warm-up sends and inboxes attached to deleted campaigns count here but not there.
        </p>
      </div>
    </div>
  );
}
