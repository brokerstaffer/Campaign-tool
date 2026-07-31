import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

/** Lazy: called on first expand only, so the grid never pays for closed rows. */
export async function GET(
  request: NextRequest,
  // Next 16 wraps route params in a Promise.
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const campaignId = Number(id);
  if (!Number.isInteger(campaignId)) {
    return NextResponse.json({ error: "Invalid campaign id" }, { status: 400 });
  }

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch {
    return NextResponse.json({ error: "Invalid filters" }, { status: 400 });
  }

  try {
    const { data, error } = await getSupabase().rpc("analytics_campaign_steps", {
      p_campaign_id: campaignId,
      p_from: filters.from,
      p_to: filters.to,
    });
    if (error) throw new Error(error.message);

    const steps = (data ?? []).map((s: Record<string, unknown>) => ({
      stepId: Number(s.sequence_step_id),
      order: s.step_order === null ? null : Number(s.step_order),
      subject: s.email_subject as string | null,
      body: s.email_body as string | null,
      waitInDays: s.wait_in_days === null ? null : Number(s.wait_in_days),
      threadReply: Boolean(s.thread_reply),
      isVariant: Boolean(s.is_variant),
      sent: Number(s.sent),
      leadsContacted: Number(s.leads_contacted),
      replies: Number(s.unique_replies),
      bounced: Number(s.bounced),
      unsubscribed: Number(s.unsubscribed),
      interested: Number(s.interested),
    }));

    return NextResponse.json({ steps });
  } catch (error) {
    console.error("[api/analytics/campaigns/steps]", error);
    return NextResponse.json({ error: "Failed to load steps" }, { status: 500 });
  }
}
