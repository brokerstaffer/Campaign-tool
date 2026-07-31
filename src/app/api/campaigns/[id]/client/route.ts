import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const schema = z.object({
  // null unpins, returning the campaign to automatic matching.
  clientId: z.string().uuid().nullable(),
});

/**
 * PIN a campaign to a client.
 *
 * Writes match_method='manual', which the auto-matcher never overwrites. This
 * is deliberately NOT an alias: an alias changes the matching RULE and would
 * retroactively capture other campaigns, whereas a pin fixes exactly this one.
 * Aliases are edited on the client record itself, where their blast radius is
 * visible.
 */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { error } = await getSupabase()
    .from("campaign_clients")
    .update({
      client_id: parsed.data.clientId,
      match_method: parsed.data.clientId ? "manual" : "auto",
      matched_on: parsed.data.clientId ? "manual pin" : null,
      // A pin resolves ambiguity by definition.
      ambiguous: false,
      resolved_at: new Date().toISOString(),
    })
    .eq("campaign_id", campaignId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
