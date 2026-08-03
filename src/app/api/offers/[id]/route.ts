import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  niche: z.string().max(120).nullable().optional(),
  active: z.boolean().optional(),
  /** Nominate which campaign's sequence represents this offer. */
  sourceCampaignId: z.number().int().positive().nullable().optional(),
});

async function requireSession() {
  const cookieStore = await cookies();
  return verifySessionToken(process.env.AUTH_SECRET ?? "", cookieStore.get(AUTH_COOKIE)?.value);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireSession())?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const parsed = Patch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid offer" }, { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name.trim();
  if (parsed.data.niche !== undefined) patch.niche = parsed.data.niche?.trim() || null;
  if (parsed.data.active !== undefined) patch.active = parsed.data.active;
  if (parsed.data.sourceCampaignId !== undefined) {
    patch.source_campaign_id = parsed.data.sourceCampaignId;
  }

  const { error } = await getSupabase()
    .from("offers")
    .update(patch)
    .eq("id", id)
    .eq("team_id", TEAM_ID());

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * Deleting an offer detaches its campaigns (ON DELETE CASCADE on
 * campaign_offers) but touches no campaign — the same rule as deleting a
 * client. Losing the label must never risk the thing it labelled.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await requireSession())?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const { error } = await getSupabase()
    .from("offers")
    .delete()
    .eq("id", id)
    .eq("team_id", TEAM_ID());

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
