import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

/*
 * The values behind the reply filters (REQ page 2: "brokerage/office/brand,
 * city/county, sales-volume buckets, company").
 *
 * Read from the data rather than hardcoded — brokerage names and cities come
 * from leads and change without a deploy, the same reason the dimensions
 * themselves live in a table.
 *
 * Capped at 50 per dimension, ordered by frequency: "Current brokerage" has
 * 1,329 distinct values, and a dropdown listing all of them is a phone book
 * rather than a filter. The tail stays reachable by typing.
 */

const DIMENSIONS = ["company", "location", "sales_volume"] as const;

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
    const sb = getSupabase();
    const results = await Promise.all(
      DIMENSIONS.map(async (key) => {
        const { data, error } = await sb.rpc("analytics_reply_facet_values", {
          p_team_id: teamId,
          p_from: filters.from,
          p_to: filters.to,
          p_dimension: key,
          p_limit: 50,
        });
        if (error) throw new Error(`${key}: ${error.message}`);
        return [
          key,
          ((data ?? []) as Array<{ value: string; replies: number }>).map((r) => ({
            value: r.value,
            label: r.value,
            count: Number(r.replies),
          })),
        ] as const;
      }),
    );

    return NextResponse.json({ facets: Object.fromEntries(results) });
  } catch (error) {
    console.error("[api/analytics/replies/facets]", error);
    return NextResponse.json({ error: "Failed to load reply filters" }, { status: 500 });
  }
}
