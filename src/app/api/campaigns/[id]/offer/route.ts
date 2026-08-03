import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";

/** §6.2: "attach it to any campaign". `offerId: null` detaches. */
export const dynamic = "force-dynamic";

const Body = z.object({ offerId: z.string().uuid().nullable() });

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected { offerId: uuid | null }" }, { status: 400 });
  }

  const sb = getSupabase();
  const { error } = parsed.data.offerId
    ? await sb.from("campaign_offers").upsert(
        {
          campaign_id: campaignId,
          offer_id: parsed.data.offerId,
          actor: session.email,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "campaign_id" },
      )
    : await sb.from("campaign_offers").delete().eq("campaign_id", campaignId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
