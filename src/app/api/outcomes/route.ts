import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/server";
import { STAGE_ORDER, TERMINAL_TYPES } from "@/lib/analytics/outcomes.ts";

export const dynamic = "force-dynamic";

/*
 * Log an outcome by hand, from a reply (spec §5.5 and §7).
 *
 * §7: "Outcomes reach the system two ways: logged by hand from a reply, or fed
 * in automatically from another system." Only the automatic half existed.
 *
 * A hand-logged outcome is an ordinary `outcome_events` row — the table already
 * models it. Three properties are load-bearing:
 *
 *   * `source_platform = 'emailbison'`. The reply came from an EmailBison
 *     campaign, so this is the one case where we KNOW the campaign rather than
 *     having to infer it, and `resolution = 'provided'` records that.
 *
 *   * The id is `manual:<replyId>:<eventType>`, which makes logging the same
 *     outcome twice idempotent instead of double-counting a hire. Two different
 *     outcomes for one reply (a phone screen and later a hire) are still two
 *     rows, which is correct — they are two events.
 *
 *   * The outcomes SYNC MUST NOT DELETE THESE. It upserts by id and never
 *     deletes, so a row the feed has never heard of survives; this id scheme
 *     also cannot collide with the feed's UUIDs.
 */

const VALID_TYPES = new Set<string>([...STAGE_ORDER, ...TERMINAL_TYPES]);

const Body = z.object({
  replyId: z.number().int().positive(),
  eventType: z.string().refine((t) => VALID_TYPES.has(t), {
    message: "unknown outcome type",
  }),
  /** Defaults to the reply's own timestamp — usually what the operator means. */
  occurredAt: z.string().datetime().optional(),
});

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  const sb = getSupabase();

  const { data: reply, error: replyError } = await sb
    .from("replies")
    .select("id, team_id, campaign_id, lead_id, from_email_address, date_received")
    .eq("id", parsed.data.replyId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (replyError) {
    return NextResponse.json({ error: replyError.message }, { status: 500 });
  }
  if (!reply) {
    return NextResponse.json({ error: "Reply not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { error } = await sb.from("outcome_events").upsert(
    {
      id: `manual:${reply.id}:${parsed.data.eventType}`,
      team_id: teamId,
      email: reply.from_email_address,
      event_type: parsed.data.eventType,
      occurred_at: parsed.data.occurredAt ?? reply.date_received,
      voided: false,
      // The reply names its campaign, so this needs no resolver pass.
      source_platform: "emailbison",
      source_campaign_ref: reply.campaign_id ? String(reply.campaign_id) : null,
      source_lead_id: reply.lead_id,
      resolved_campaign_id: reply.campaign_id,
      resolution: "provided",
      resolved_at: now,
      synced_at: now,
    },
    { onConflict: "id" },
  );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** Removes a hand-logged outcome. Only ever the manual ones. */
export async function DELETE(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id") ?? "";
  /*
   * Guarded, not merely filtered. Without this prefix check the endpoint would
   * delete rows the feed owns, which the next sync would silently restore —
   * making the delete look like it failed intermittently.
   */
  if (!id.startsWith("manual:")) {
    return NextResponse.json(
      { error: "Only hand-logged outcomes can be removed here" },
      { status: 400 },
    );
  }

  const { error } = await getSupabase()
    .from("outcome_events")
    .delete()
    .eq("id", id)
    .eq("team_id", Number(process.env.EMAILBISON_TEAM_ID || 2));

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
