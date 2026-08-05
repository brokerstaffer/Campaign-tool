import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

interface Row {
  period: string;
  stat_date: string;
  sent: number;
  prospects: number;
  replies: number;
  human: number;
  positive: number;
  bounces: number;
}

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  try {
    const { data, error } = await getSupabase().rpc("analytics_timeseries", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
      p_exclude_weekends: filters.excludeWeekends,
      p_compare: filters.compare,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []) as Row[];

    /*
     * The chart pairs the two periods BY INDEX, so both arrays have to be the
     * same length or the overlay silently drifts.
     *
     * They usually are — two windows of equal calendar length. But `Exclude
     * weekends` filters each window on its own, and 30 days starting on a
     * Tuesday holds 22 weekdays while the 30 before it hold 21. That left the
     * most recent day with no counterpart at all: the comparison line stopped
     * one point short of the line it was drawn against.
     *
     * Aligned from the TAIL, so the newest day — the one being read — always
     * has a partner, and any shortfall falls off the oldest edge where it is
     * both visible and harmless. `null` renders as a gap; the chart's `value()`
     * already returns null for a missing point.
     */
    const alignToTail = <T,>(series: T[], length: number): Array<T | null> =>
      series.length >= length
        ? series.slice(series.length - length)
        : [...Array<null>(length - series.length).fill(null), ...series];

    const shape = (r: Row) => ({
      date: r.stat_date,
      sent: Number(r.sent),
      prospects: Number(r.prospects),
      replies: Number(r.replies),
      human: Number(r.human),
      positive: Number(r.positive),
      bounces: Number(r.bounces),
    });

    const points = rows.filter((r) => r.period === "current").map(shape);

    return NextResponse.json({
      points,
      // The comparison series is returned separately rather than merged: the
      // two periods have different dates, and zipping them by index here keeps
      // that fiction out of the chart component.
      compare: filters.compare
        ? alignToTail(rows.filter((r) => r.period === "previous").map(shape), points.length)
        : undefined,
      compareLabel:
        filters.compare && filters.compareFrom
          ? { from: filters.compareFrom, to: filters.compareTo }
          : undefined,
      mode: filters.mode,
    });
  } catch (error) {
    console.error("[api/analytics/timeseries]", error);
    return NextResponse.json({ error: "Failed to load chart data" }, { status: 500 });
  }
}
