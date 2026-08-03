import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { COPY_DIMENSION_KEYS, isCopyDimension } from "@/lib/analytics/copy-dimensions.ts";

/*
 * Copy dimension performance (spec §6.1) and tagging (§6.3).
 *
 * GET returns the table for ONE dimension plus its coverage. Coverage is not a
 * footnote: until the 284 sequence steps are tagged this table describes a
 * fraction of sending, and a ranking computed over 8% of volume that presents
 * itself as "how your copy performs" is worse than an empty state.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

export async function GET(request: NextRequest) {
  const dimension = request.nextUrl.searchParams.get("dimension") ?? "subject_line";
  if (!isCopyDimension(dimension)) {
    return NextResponse.json(
      { error: `Unknown dimension. Expected one of: ${COPY_DIMENSION_KEYS.join(", ")}` },
      { status: 400 },
    );
  }

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const sb = getSupabase();
  const args = {
    p_team_id: TEAM_ID(),
    p_dimension: dimension,
    p_from: filters.from,
    p_to: filters.to,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
  };

  const [rows, coverage] = await Promise.all([
    sb.rpc("analytics_copy_dimension", args),
    sb.rpc("analytics_copy_coverage", args),
  ]);

  const failed = rows.error ?? coverage.error;
  if (failed) return NextResponse.json({ error: failed.message }, { status: 500 });

  return NextResponse.json({
    dimension,
    from: filters.from,
    to: filters.to,
    rows: rows.data ?? [],
    coverage: coverage.data?.[0] ?? null,
  });
}
