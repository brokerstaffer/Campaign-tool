import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

/*
 * The Replies view's breakdown cards (spec §5.5).
 *
 * "What do our repliers have in common?" — one card per configured dimension,
 * each grouping replies by one attribute of the person who replied.
 *
 * The dimension list is READ FROM THE DATABASE, not hardcoded, because §5.5
 * requires it to be per-client configurable: "another client can be set up with
 * their own list without a rebuild". When exactly one client is selected, that
 * client's own list wins over the default.
 *
 * Every card is fetched in one parallel batch. They share a date range and a
 * positive-only toggle, so a card that lagged behind the others would show a
 * different population from the one beside it.
 */

interface DimensionRow {
  key: string;
  label: string;
  source: string;
  bucket: string | null;
  sort_position: number;
}

interface BreakdownRow {
  value: string;
  replies: number;
  positive: number;
  sort_order: number;
  /** Across every group, not just the twelve returned. */
  grand_total: number;
  group_count: number;
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

  const positiveOnly = request.nextUrl.searchParams.get("positive") === "1";
  const clientIds = filters.clientIds.length ? filters.clientIds : null;
  const campaignIds = filters.campaignIds.length ? filters.campaignIds : null;
  const sb = getSupabase();

  try {
    const { data: dims, error: dimError } = await sb.rpc("analytics_reply_dimensions", {
      p_team_id: teamId,
      // A per-client list only makes sense when the view is scoped to one client.
      p_client_id: filters.clientIds.length === 1 ? filters.clientIds[0] : null,
    });
    if (dimError) throw new Error(dimError.message);

    const dimensions = ((dims ?? []) as DimensionRow[]).sort(
      (a, b) => a.sort_position - b.sort_position,
    );

    const breakdowns = await Promise.all(
      dimensions.map(async (d) => {
        const { data, error } = await sb.rpc("analytics_reply_breakdown", {
          p_team_id: teamId,
          p_from: filters.from,
          p_to: filters.to,
          p_dimension: d.key,
          p_client_ids: clientIds,
          p_campaign_ids: campaignIds,
          p_positive_only: positiveOnly,
          p_limit: 12,
        });
        if (error) throw new Error(`${d.key}: ${error.message}`);

        const rows = ((data ?? []) as BreakdownRow[]).map((r) => ({
          value: r.value,
          replies: Number(r.replies),
          positive: Number(r.positive),
        }));

        const raw = (data ?? []) as BreakdownRow[];

        return {
          key: d.key,
          label: d.label,
          bucket: d.bucket,
          rows,
          /*
           * §5.5: "Each card carries its own reply count."
           *
           * The TRUE total across every group, not the sum of the twelve rows
           * shown. Summing the visible rows made a dimension with a long tail
           * under-report itself — the six cards read 6,378 / 3,358 / 3,630 /
           * 8,015 for one identical population, which is six different answers
           * to the same question.
           */
          total: Number(raw[0]?.grand_total ?? 0),
          groupCount: Number(raw[0]?.group_count ?? rows.length),
          /*
           * How much of this card is 'Unknown'. A dimension answered for 8% of
           * repliers is not a finding, and the card has to be able to say so
           * rather than presenting a confident-looking bar chart of nothing.
           */
          unknown: rows.find((r) => r.value === "Unknown" || r.value === "Unassigned")?.replies ?? 0,
          shown: rows.reduce((sum, r) => sum + r.replies, 0),
        };
      }),
    );

    return NextResponse.json({
      range: { from: filters.from, to: filters.to },
      positiveOnly,
      dimensions: dimensions.map((d) => ({ key: d.key, label: d.label })),
      breakdowns,
    });
  } catch (error) {
    console.error("[api/analytics/replies]", error);
    return NextResponse.json({ error: "Failed to load reply breakdowns" }, { status: 500 });
  }
}
