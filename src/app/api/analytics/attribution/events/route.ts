import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

/*
 * Every outcome the feed sends, paged — not only the ones that attributed.
 *
 * Paging and filtering are both in SQL. A raw list built from a `.select()` is
 * silently capped at 1000 rows by PostgREST, which for a 1,923-event feed means
 * the table would look complete at exactly the point it stopped being complete
 * (CLAUDE.md rule 7). `total_count` is a window count over the filtered set, so
 * the header states a counted number rather than one inferred from page size.
 */

const PAGE_SIZE = 50;

interface Row {
  id: string;
  email: string | null;
  event_type: string;
  occurred_at: string;
  source_platform: string;
  source_campaign_ref: string | null;
  resolution: string;
  campaign_id: number | null;
  campaign_name: string | null;
  client_name: string | null;
  total_count: number;
}

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const params = request.nextUrl.searchParams;

  let filters;
  try {
    filters = resolveFilters(params, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const page = Math.max(1, Number(params.get("page")) || 1);
  const types = params.get("types")?.split(",").filter(Boolean) ?? [];
  // The shared `platforms` filter, already parsed and validated by
  // resolveFilters — read from there rather than re-splitting the raw string,
  // so the tab's own source dropdown and the global filter cannot disagree.
  const platforms = filters.platforms.length
    ? filters.platforms
    : (params.get("platforms")?.split(",").filter(Boolean) ?? []);
  const search = params.get("q")?.trim() || null;

  try {
    const sb = getSupabase();
    const [events, facets] = await Promise.all([
      sb.rpc("analytics_outcome_events", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
        p_types: types.length ? types : null,
        p_platforms: platforms.length ? platforms : null,
        p_client_ids: filters.clientIds.length ? filters.clientIds : null,
        p_search: search,
        p_limit: PAGE_SIZE,
        p_sort: request.nextUrl.searchParams.get("sort"),
      p_dir: request.nextUrl.searchParams.get("dir") === "asc" ? "asc" : "desc",
      p_offset: (page - 1) * PAGE_SIZE,
      }),
      sb.rpc("analytics_outcome_facets", {
        p_team_id: teamId,
        p_from: filters.from,
        p_to: filters.to,
      }),
    ]);
    if (events.error) throw new Error(events.error.message);
    if (facets.error) throw new Error(facets.error.message);

    const rows = (events.data ?? []) as Row[];

    return NextResponse.json({
      page,
      pageSize: PAGE_SIZE,
      // Zero rows means zero matches, not an unknown total.
      total: rows.length ? Number(rows[0].total_count) : 0,
      rows: rows.map((r) => ({
        id: r.id,
        email: r.email,
        type: r.event_type,
        occurredAt: r.occurred_at,
        platform: r.source_platform,
        sourceRef: r.source_campaign_ref,
        resolution: r.resolution,
        campaignId: r.campaign_id,
        campaign: r.campaign_name,
        client: r.client_name,
      })),
      facets: ((facets.data ?? []) as Array<{ kind: string; value: string; n: number }>).map(
        (f) => ({ kind: f.kind, value: f.value, n: Number(f.n) }),
      ),
    });
  } catch (error) {
    console.error("[api/analytics/attribution/events]", error);
    return NextResponse.json({ error: "Failed to load outcome events" }, { status: 500 });
  }
}
