import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { createEmailBisonClient, EmailBisonApiError } from "@/lib/emailbison/client.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Campaign settings (spec §9.2 Settings tab).
 *
 * Same discipline as the status actions: EmailBison decides, the cache is
 * written only after a 2xx, and the attempt is recorded with what the values
 * were before. §9.5 — the screen never claims something happened that didn't.
 *
 * `before_state` matters more here than anywhere else in the app. EmailBison
 * keeps no history of settings, so this log is the only record of what the
 * daily send limit was before someone changed it.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

/*
 * Exactly the fields PATCH /api/campaigns/{id}/update accepts, and no others.
 * Status is deliberately absent: it is changed only through the pause/resume/
 * archive endpoints, which have their own eligibility rules and confirmation.
 */
const Settings = z
  .object({
    name: z.string().min(1).max(255),
    max_emails_per_day: z.number().int().min(0).max(100_000),
    max_new_leads_per_day: z.number().int().min(0).max(100_000),
    plain_text: z.boolean(),
    open_tracking: z.boolean(),
    can_unsubscribe: z.boolean(),
    include_auto_replies_in_stats: z.boolean(),
    sequence_prioritization: z.enum(["followups", "new_leads"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "No settings supplied" });

/** Only the columns that exist locally, named as they are in our schema. */
const COLUMN_OF: Record<string, string> = {
  name: "name",
  max_emails_per_day: "max_emails_per_day",
  max_new_leads_per_day: "max_new_leads_per_day",
  plain_text: "plain_text",
  open_tracking: "open_tracking",
  can_unsubscribe: "can_unsubscribe",
  include_auto_replies_in_stats: "include_auto_replies_in_stats",
  sequence_prioritization: "sequence_prioritization",
};

export async function PATCH(
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

  const parsed = Settings.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid settings", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sb = getSupabase();
  const teamId = TEAM_ID();

  const { data: before } = await sb
    .from("campaigns")
    .select(
      "id, name, max_emails_per_day, max_new_leads_per_day, plain_text, open_tracking, can_unsubscribe, include_auto_replies_in_stats, sequence_prioritization",
    )
    .eq("id", campaignId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (!before) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const patch = parsed.data as Record<string, unknown>;

  /*
   * Only send what actually changed. EmailBison's update endpoint documents
   * that omitted booleans default to false — so echoing the full form back
   * would silently switch off any flag the user never touched.
   */
  const changed = Object.fromEntries(
    Object.entries(patch).filter(
      ([key, value]) => value !== (before as Record<string, unknown>)[key],
    ),
  );

  if (Object.keys(changed).length === 0) {
    return NextResponse.json({ ok: true, changed: {}, note: "No values differed" });
  }

  try {
    await createEmailBisonClient().updateCampaign(campaignId, changed);
  } catch (error) {
    const message =
      error instanceof EmailBisonApiError
        ? describe(error)
        : error instanceof Error
          ? error.message
          : String(error);

    await sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: before.name,
      action: "update",
      actor: session.email,
      status: "error",
      error: message,
      before_state: pick(before, Object.keys(changed)),
      after_state: null,
    });

    return NextResponse.json({ error: message }, { status: 502 });
  }

  const localPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changed)) {
    const column = COLUMN_OF[key];
    if (column) localPatch[column] = value;
  }

  await Promise.all([
    sb.from("campaigns").update(localPatch).eq("id", campaignId),
    sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: before.name,
      action: "update",
      actor: session.email,
      status: "ok",
      before_state: pick(before, Object.keys(changed)),
      after_state: changed,
    }),
  ]);

  return NextResponse.json({ ok: true, changed });
}

function pick(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, source[k]]));
}

function describe(error: EmailBisonApiError): string {
  const body = error.response;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message) return record.message;
    if (record.errors && typeof record.errors === "object") {
      const first = Object.values(record.errors as Record<string, unknown>)[0];
      if (Array.isArray(first) && typeof first[0] === "string") return first[0];
    }
  }
  return error.message;
}
