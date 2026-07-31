import { NextResponse, type NextRequest } from "next/server";
import { loadKpis } from "@/lib/analytics/kpis";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

// Analytics reads are never cached: a filter change must always hit the RPC.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);

  let filters;
  try {
    // The SAME parser the client hook uses, so the two can't disagree about
    // what "7d" means or whether `to` is inclusive.
    filters = resolveFilters(
      request.nextUrl.searchParams,
      toISODate(new Date()),
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  try {
    const data = await loadKpis(filters, teamId);
    return NextResponse.json({ ...data, range: { from: filters.from, to: filters.to } });
  } catch (error) {
    console.error("[api/analytics/kpis]", error);
    return NextResponse.json(
      { error: "Failed to load metrics" },
      { status: 500 },
    );
  }
}
