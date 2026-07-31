import { NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Picker options for the filter bar.
 *
 * Cached for 5 minutes: it's identical for every view, gets hit on every page
 * load, and the underlying entity list changes on a 30-minute sync cadence at
 * most. Private, because it names the client roster.
 */
export async function GET() {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const sb = getSupabase();

  const [campaigns, clients, mappings] = await Promise.all([
    sb.from("campaigns")
      .select("id, name, lifetime_emails_sent")
      .eq("team_id", teamId)
      .order("lifetime_emails_sent", { ascending: false }),
    sb.from("clients").select("id, name").eq("team_id", teamId).order("name"),
    sb.from("campaign_clients").select("campaign_id, excluded"),
  ]);

  // Excluded campaigns are omitted from the picker: they're excluded from every
  // number, so offering them as a filter would let you select a campaign and
  // get an empty dashboard with no explanation.
  const excluded = new Set(
    (mappings.data ?? []).filter((m) => m.excluded).map((m) => m.campaign_id),
  );

  return NextResponse.json(
    {
      campaigns: (campaigns.data ?? [])
        .filter((c) => !excluded.has(c.id))
        .map((c) => ({
          value: String(c.id),
          label: c.name,
          hint: (c.lifetime_emails_sent ?? 0).toLocaleString("en-US"),
        })),
      clients: (clients.data ?? []).map((c) => ({
        value: c.id,
        label: c.name,
      })),
    },
    { headers: { "Cache-Control": "private, max-age=300" } },
  );
}
