"use client";

import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAnalyticsFilters } from "./filters-context";
import { DASH, compactNumber, fullNumber, percent, ratio } from "@/lib/analytics/format.ts";
import {
  PLATFORM_LABELS,
  RESOLUTION_LABELS,
  isTerminal,
  outcomeLabel,
} from "@/lib/analytics/outcomes.ts";
import { cn } from "@/lib/utils";

/*
 * The Attribution tab (spec §7) — "what happened after the reply".
 *
 * Composed the same way Infrastructure is, because the same failure applies: a
 * single long table of outcomes is a data dump. SUMMARY → FUNNEL → DETAIL.
 *
 * THE COVERAGE STRIP IS FIRST AND IS NOT DECORATION. Only part of the feed can
 * be credited to an EmailBison campaign, and the campaign table below is built
 * from exactly that part. Reading "237 outcomes" off a campaign row without
 * knowing that a third of the feed is another platform's is how a partial number
 * becomes a decision. So the split is stated before anything derived from it.
 *
 * The three platforms are a real distinction, not a taxonomy exercise:
 *   EmailBison  the feed named one of our campaigns — credited directly
 *   Instantly   a different sending platform — counted, never credited to us
 *   Direct      logged by the client with no campaign — matched by first send
 */

interface Measure {
  key: string;
  label: string;
  count: number;
  emailsPer: number | null;
}
interface Stage {
  type: string;
  events: number;
  people: number;
}
interface TypeTotal {
  type: string;
  events: number;
  people: number;
  attributed: number;
  unattributed: number;
}
interface Coverage {
  total: number;
  attributed: number;
  otherPlatform: number;
  unattributed: number;
  pending: number;
  byMethod: Record<string, number>;
  byPlatform: Record<string, number>;
}
interface CampaignRow {
  campaignId: number;
  name: string | null;
  client: string | null;
  sent: number;
  outcomes: number;
  people: number;
  byType: Record<string, number>;
}
interface Summary {
  emailsSent: number;
  measures: Measure[];
  funnel: Stage[];
  totals: TypeTotal[];
  coverage: Coverage | null;
  campaigns: CampaignRow[];
}

interface EventRow {
  id: string;
  email: string | null;
  type: string;
  occurredAt: string;
  platform: string;
  sourceRef: string | null;
  resolution: string;
  campaignId: number | null;
  campaign: string | null;
  client: string | null;
}
interface EventsResponse {
  page: number;
  pageSize: number;
  total: number;
  rows: EventRow[];
  facets: Array<{ kind: string; value: string; n: number }>;
}

/** Platform hues. Entity-fixed, never rank-ordered. */
const PLATFORM_FILL: Record<string, string> = {
  emailbison: "#2a78d6",
  instantly: "#4a3aa7",
  direct: "#94a3b8",
};

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("rounded-xl border bg-card shadow-sm", className)}>{children}</div>;
}

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/* ---------- coverage --------------------------------------------------- */

function CoverageStrip({ coverage }: { coverage: Coverage }) {
  const { total } = coverage;
  const platforms = ["emailbison", "instantly", "direct"].filter(
    (p) => (coverage.byPlatform[p] ?? 0) > 0,
  );

  return (
    <Card>
      <SectionHead
        title="Where the outcomes come from"
        note={`${fullNumber(total)} outcomes in range`}
      />
      <div className="px-4 py-4 sm:px-5">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {platforms.map((p) => (
            <span
              key={p}
              title={`${PLATFORM_LABELS[p]}: ${fullNumber(coverage.byPlatform[p])}`}
              // A 2px surface gap between segments, so adjacent fills stay
              // distinguishable without a border.
              className="border-r-2 border-card last:border-r-0"
              style={{
                width: `${((coverage.byPlatform[p] ?? 0) / total) * 100}%`,
                backgroundColor: PLATFORM_FILL[p],
              }}
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          {platforms.map((p) => (
            <span key={p} className="flex items-center gap-2 text-xs">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: PLATFORM_FILL[p] }}
                aria-hidden
              />
              <span className="font-medium">{PLATFORM_LABELS[p]}</span>
              <span className="tabular-nums text-muted-foreground">
                {fullNumber(coverage.byPlatform[p])} ·{" "}
                {percent((coverage.byPlatform[p] ?? 0) / total, 0)}
              </span>
            </span>
          ))}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          {[
            {
              label: "Credited to a campaign",
              value: coverage.attributed,
              note: "counts in the campaign table below",
            },
            {
              label: "Another platform",
              value: coverage.otherPlatform,
              note: "Instantly — not credited to us",
            },
            {
              label: "No campaign found",
              value: coverage.unattributed,
              note: "looked, nothing matched",
            },
            {
              label: "Not yet resolved",
              value: coverage.pending,
              // Honestly different from "we looked and found nothing" — this one
              // shrinks on its own as the hourly resolver drains its queue.
              note: "resolver still working through these",
            },
          ].map((cell) => (
            <div key={cell.label} className="bg-card px-4 py-3">
              <dt className="text-xs text-muted-foreground">{cell.label}</dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums">
                {fullNumber(cell.value)}
              </dd>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                {cell.note}
              </p>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

/* ---------- conversion measures ---------------------------------------- */

function Measures({ measures, emailsSent }: { measures: Measure[]; emailsSent: number }) {
  return (
    <Card>
      <SectionHead
        title="What it costs to earn one"
        note={`over ${compactNumber(emailsSent)} emails sent`}
      />
      <div className="grid grid-cols-2 divide-x divide-y lg:grid-cols-4 lg:divide-y-0">
        {measures.map((m) => (
          <div key={m.key} className="px-4 py-4 sm:px-5">
            <p className="text-xs text-muted-foreground">{m.label}</p>
            <p className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl">
              {m.emailsPer == null ? DASH : ratio(m.emailsPer)}
            </p>
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              {m.count > 0 ? `${fullNumber(m.count)} in range` : "none in range"}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- funnel ------------------------------------------------------ */

function Funnel({ funnel, totals }: { funnel: Stage[]; totals: TypeTotal[] }) {
  /*
   * Measured against the FIRST stage, not the preceding one.
   *
   * A step-through rate is the natural thing to show here and it was wrong: the
   * live data rendered "Phone Screen 112%" and "Interview 288.9%", because these
   * event types are logged independently rather than as a strict progression —
   * someone can be recorded at interview with no phone_screen row ever written.
   * A percentage over 100 in a funnel reads as a bug in the dashboard, and here
   * it would have been a bug in the premise instead: the arithmetic was fine,
   * the claim that stage N-1 gates stage N is what's false.
   *
   * Share of introductions is a claim the data actually supports.
   */
  const top = funnel[0]?.events || 0;
  const terminal = totals.filter((t) => isTerminal(t.type));

  return (
    <Card className="self-start">
      <SectionHead title="The funnel" note="stage order is fixed, not sorted by size" />
      <div className="space-y-3 px-4 py-4 sm:px-5">
        {funnel.map((stage, i) => (
          <div key={stage.type} className="flex items-center gap-2 sm:gap-4">
            <span className="w-28 shrink-0 truncate text-sm sm:w-36">
              {outcomeLabel(stage.type)}
            </span>
            <span className="relative h-6 min-w-8 flex-1 overflow-hidden rounded-md bg-muted/60">
              <span
                className="absolute inset-y-0 left-0 rounded-md bg-[#2a78d6]"
                style={{ width: `${top ? (stage.events / top) * 100 : 0}%` }}
              />
            </span>
            <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums">
              {fullNumber(stage.events)}
            </span>
            <span className="hidden w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
              {i === 0 || !top ? DASH : percent(stage.events / top, 1)}
            </span>
          </div>
        ))}
      </div>

      <p className="px-4 pb-4 text-[11px] leading-snug text-muted-foreground sm:px-5">
        Percentages are share of introductions. Each outcome is logged on its own,
        so a person can appear at a later stage without the earlier one — these are
        not step-through rates.
      </p>

      {terminal.length ? (
        <div className="border-t px-4 py-4 sm:px-5">
          <p className="text-xs font-medium text-muted-foreground">
            Where people stopped
          </p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Not stages in the funnel — putting these above would read as though
            people advanced into them.
          </p>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            {terminal.map((t) => (
              <span key={t.type} className="text-sm">
                <span className="text-muted-foreground">{outcomeLabel(t.type)}</span>{" "}
                <span className="font-medium tabular-nums">{fullNumber(t.events)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/* ---------- campaigns that produce results ------------------------------ */

function Campaigns({ rows }: { rows: CampaignRow[] }) {
  const [limit, setLimit] = useState(12);
  const shown = rows.slice(0, limit);

  return (
    <Card>
      <SectionHead
        title="Which campaigns produce results"
        note="EmailBison campaigns only — sends are the only volume we can attribute against"
      />
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No outcomes credited to a campaign in this range.
        </p>
      ) : (
        <>
          {/* Under `sm` the five numeric columns cannot coexist with a campaign
              name; a horizontally-scrolled table there is a table nobody reads.
              Same data, stacked. */}
          <ul className="divide-y sm:hidden">
            {shown.map((r) => (
              <li key={r.campaignId} className="px-4 py-3">
                <p className="truncate text-sm font-medium">
                  {r.name ?? `Campaign ${r.campaignId}`}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {r.client ?? "Unassigned"}
                </p>
                <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                  <span className="flex gap-1.5">
                    <dt className="text-muted-foreground">Outcomes</dt>
                    <dd className="font-medium tabular-nums">{fullNumber(r.outcomes)}</dd>
                  </span>
                  <span className="flex gap-1.5">
                    <dt className="text-muted-foreground">People</dt>
                    <dd className="tabular-nums">{fullNumber(r.people)}</dd>
                  </span>
                  <span className="flex gap-1.5">
                    <dt className="text-muted-foreground">Sent</dt>
                    <dd className="tabular-nums">{r.sent ? fullNumber(r.sent) : DASH}</dd>
                  </span>
                  <span className="flex gap-1.5">
                    <dt className="text-muted-foreground">Per outcome</dt>
                    <dd className="tabular-nums">
                      {r.sent && r.outcomes ? ratio(r.sent / r.outcomes) : DASH}
                    </dd>
                  </span>
                </dl>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[600px] table-fixed text-sm">
              {/* Without a template the four numeric columns take what they
                  want and the name — the only column anyone scans by — gets
                  the remainder. */}
              <colgroup>
                <col className="w-[38%]" />
                <col />
                <col />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="px-5 py-2.5 text-left font-medium">Campaign</th>
                  <th className="px-3 py-2.5 text-right font-medium">Sent</th>
                  <th className="px-3 py-2.5 text-right font-medium">Outcomes</th>
                  <th className="px-3 py-2.5 text-right font-medium">People</th>
                  <th className="px-5 py-2.5 text-right font-medium">Per outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shown.map((r) => (
                  <tr key={r.campaignId} className="hover:bg-muted/40">
                    <td className="px-5 py-2.5">
                      <p className="truncate font-medium">
                        {r.name ?? `Campaign ${r.campaignId}`}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.client ?? "Unassigned"}
                        {Object.keys(r.byType).length
                          ? ` · ${Object.entries(r.byType)
                              .sort((a, b) => b[1] - a[1])
                              .slice(0, 3)
                              .map(([t, n]) => `${outcomeLabel(t)} ${n}`)
                              .join(" · ")}`
                          : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {r.sent ? fullNumber(r.sent) : DASH}
                    </td>
                    <td className="px-3 py-2.5 text-right font-medium tabular-nums">
                      {fullNumber(r.outcomes)}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {fullNumber(r.people)}
                    </td>
                    <td className="px-5 py-2.5 text-right tabular-nums">
                      {/* Blank rather than 0 when the range holds no sends for a
                          campaign whose outcomes landed inside it. */}
                      {r.sent && r.outcomes ? ratio(r.sent / r.outcomes) : DASH}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > limit ? (
            <button
              type="button"
              onClick={() => setLimit((n) => n + 25)}
              className="w-full border-t py-2.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              Show {Math.min(25, rows.length - limit)} more of {rows.length}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

/* ---------- every event ------------------------------------------------- */

function Events() {
  const { toQueryString } = useAnalyticsFilters();
  const queryString = toQueryString();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [platform, setPlatform] = useState<string | null>(null);

  /*
   * The typed value drives the input; a debounced copy drives the query. Typing
   * an eleven-character address otherwise fires eleven server round trips, ten
   * of which are already stale before they land.
   */
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const params = useMemo(() => {
    const next = new URLSearchParams(queryString);
    next.set("page", String(page));
    if (debounced) next.set("q", debounced);
    if (type) next.set("types", type);
    if (platform) next.set("platforms", platform);
    return next;
  }, [queryString, page, debounced, type, platform]);

  const { data, isFetching } = useQuery<EventsResponse>({
    queryKey: ["attribution-events", params.toString()],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/attribution/events?${params}`);
      if (!response.ok) throw new Error("Failed to load outcome events");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const types = (data?.facets ?? []).filter((f) => f.kind === "type");
  const platforms = (data?.facets ?? []).filter((f) => f.kind === "platform");
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / (data?.pageSize ?? 50)));

  /** Any filter change invalidates the current page number. */
  function reset<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(1);
    };
  }

  return (
    <Card>
      <SectionHead
        title="Every outcome"
        note={`${fullNumber(total)} matching${isFetching ? " · loading" : ""}`}
      />

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-5">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-auto sm:max-w-64">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => reset(setSearch)(e.target.value)}
            placeholder="Search email…"
            className="h-8 pl-8 text-sm"
          />
        </div>

        <select
          aria-label="Filter by outcome"
          value={type ?? ""}
          onChange={(e) => reset(setType)(e.target.value || null)}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none"
        >
          <option value="">All outcomes</option>
          {types.map((f) => (
            <option key={f.value} value={f.value}>
              {outcomeLabel(f.value)} ({f.n})
            </option>
          ))}
        </select>

        <select
          aria-label="Filter by source"
          value={platform ?? ""}
          onChange={(e) => reset(setPlatform)(e.target.value || null)}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:flex-none"
        >
          <option value="">All sources</option>
          {platforms.map((f) => (
            <option key={f.value} value={f.value}>
              {PLATFORM_LABELS[f.value] ?? f.value} ({f.n})
            </option>
          ))}
        </select>
      </div>

      <ul className="divide-y sm:hidden">
        {(data?.rows ?? []).map((r) => (
          <li key={r.id} className="px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-sm font-medium">{outcomeLabel(r.type)}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {new Date(r.occurredAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>
            <p className={cn("mt-0.5 truncate text-sm", !r.email && "text-muted-foreground")}>
              {r.email ?? "no email on record"}
            </p>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: PLATFORM_FILL[r.platform] ?? "#94a3b8" }}
                aria-hidden
              />
              <span className="truncate">
                {r.campaign ?? RESOLUTION_LABELS[r.resolution] ?? r.resolution}
              </span>
            </p>
          </li>
        ))}
      </ul>

      <div className="hidden overflow-x-auto sm:block">
        {/* Explicit widths: with only five columns a full-width auto table
            spreads them to the far edges on a wide screen, and a row stops
            reading as a row. */}
        <table className="w-full min-w-[860px] table-fixed text-sm">
          <colgroup>
            <col className="w-32" />
            <col className="w-[22%]" />
            <col className="w-48" />
            <col className="w-44" />
            <col />
          </colgroup>
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-5 py-2.5 text-left font-medium">Date</th>
              <th className="px-3 py-2.5 text-left font-medium">Person</th>
              <th className="px-3 py-2.5 text-left font-medium">Outcome</th>
              <th className="px-3 py-2.5 text-left font-medium">Source</th>
              <th className="px-5 py-2.5 text-left font-medium">Credited to</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {(data?.rows ?? []).map((r) => (
              <tr key={r.id} className="hover:bg-muted/40">
                <td className="whitespace-nowrap px-5 py-2.5 tabular-nums text-muted-foreground">
                  {new Date(r.occurredAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </td>
                <td className="px-3 py-2.5">
                  {/* 5 rows in the feed carry no email at all. They are real
                      outcomes, so they render as an explicit absence. */}
                  <span className={cn("block truncate", !r.email && "text-muted-foreground")}>
                    {r.email ?? "no email on record"}
                  </span>
                </td>
                <td className="truncate px-3 py-2.5">{outcomeLabel(r.type)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: PLATFORM_FILL[r.platform] ?? "#94a3b8" }}
                      aria-hidden
                    />
                    {PLATFORM_LABELS[r.platform] ?? r.platform}
                  </span>
                </td>
                <td className="px-5 py-2.5">
                  {r.campaign ? (
                    <>
                      <span className="block truncate">{r.campaign}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {RESOLUTION_LABELS[r.resolution] ?? r.resolution}
                      </span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      {RESOLUTION_LABELS[r.resolution] ?? r.resolution}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted-foreground">
          No outcomes match these filters.
        </p>
      ) : (
        <div className="flex items-center justify-between border-t px-5 py-2.5 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {(page - 1) * (data?.pageSize ?? 50) + 1}–
            {Math.min(page * (data?.pageSize ?? 50), total)} of {fullNumber(total)}
          </span>
          <span className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Previous page"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tabular-nums">
              {page} / {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="rounded p-1 hover:bg-muted disabled:opacity-40"
              aria-label="Next page"
            >
              <ChevronRight className="size-4" />
            </button>
          </span>
        </div>
      )}
    </Card>
  );
}

/* ---------- the tab ----------------------------------------------------- */

export function AttributionView() {
  const { toQueryString } = useAnalyticsFilters();
  const queryString = toQueryString();

  const { data, isLoading, isError } = useQuery<Summary>({
    queryKey: ["attribution", queryString],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/attribution?${queryString}`);
      if (!response.ok) throw new Error("Failed to load attribution");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-xl border bg-card py-16 text-center text-sm text-muted-foreground">
        Could not load attribution.
      </div>
    );
  }

  if (!data.coverage?.total) {
    return (
      <div className="rounded-xl border bg-card py-16 text-center">
        <p className="text-sm font-medium">No outcomes in this range</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Widen the date range, or check that the outcomes sync has run.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 bg-muted/30 p-3 sm:p-4 lg:p-6">
      <CoverageStrip coverage={data.coverage} />
      <Measures measures={data.measures} emailsSent={data.emailsSent} />
      {/* The campaigns table carries five numeric columns and long campaign
          names; an even split cropped it. The funnel's content is fixed-width. */}
      {/*
        `grid-cols-1` is load-bearing, not redundant. Without an explicit
        template the implicit column is sized `auto` — i.e. to its MAX-content —
        and the funnel card grew to 793px inside a 334px viewport.
        `grid-cols-1` is `repeat(1, minmax(0, 1fr))`, which is what actually
        caps a grid item at its container.

        Side by side only from 2xl. Splitting at xl left the campaigns table
        ~830px for a campaign name plus four numeric columns, and every name
        truncated to "Properties & E…". Stacked, the same table gets the full
        width and the names read.
      */}
      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        <Funnel funnel={data.funnel} totals={data.totals} />
        <Campaigns rows={data.campaigns} />
      </div>
      <Events />
    </div>
  );
}
