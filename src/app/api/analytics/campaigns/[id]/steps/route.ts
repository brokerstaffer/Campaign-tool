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

    interface StepRow {
      stepId: number;
      order: number | null;
      subject: string | null;
      body: string | null;
      waitInDays: number | null;
      threadReply: boolean;
      isVariant: boolean;
      variantOf: number | null;
      sent: number;
      leadsContacted: number;
      replies: number;
      bounced: number;
      unsubscribed: number;
      interested: number;
    }

    const steps: StepRow[] = (data ?? []).map((s: Record<string, unknown>) => ({
      stepId: Number(s.sequence_step_id),
      order: s.step_order === null ? null : Number(s.step_order),
      subject: s.email_subject as string | null,
      body: s.email_body as string | null,
      waitInDays: s.wait_in_days === null ? null : Number(s.wait_in_days),
      threadReply: Boolean(s.thread_reply),
      isVariant: Boolean(s.is_variant),
      variantOf: s.variant_from_step_id === null ? null : Number(s.variant_from_step_id),
      sent: Number(s.sent),
      leadsContacted: Number(s.leads_contacted),
      replies: Number(s.unique_replies),
      bounced: Number(s.bounced),
      unsubscribed: Number(s.unsubscribed),
      interested: Number(s.interested),
    }));

    /*
     * Nest each variant under the step it is an alternative wording OF, so the
     * table can show three levels (§5.3).
     *
     * The spec puts Variant ABOVE Step; EmailBison attaches a variant to a
     * step, not to a campaign — 16 variants across 97 campaigns, every one
     * pointing at exactly one step. Building the spec's shape would mean
     * inventing a "Variant 1" wrapper that every campaign has exactly one of.
     *
     * A variant whose parent is missing is promoted to a top-level row rather
     * than dropped: its sends are real and would otherwise vanish from a table
     * whose whole job is that the parts add up.
     */
    const byId = new Map(steps.map((s) => [s.stepId, s]));
    const parents = steps.filter(
      (s) => !s.isVariant || s.variantOf === null || !byId.has(s.variantOf),
    );

    return NextResponse.json({
      steps: parents.map((parent) => ({
        ...parent,
        variants: steps.filter((s) => s.isVariant && s.variantOf === parent.stepId),
      })),
    });
  } catch (error) {
    console.error("[api/analytics/campaigns/steps]", error);
    return NextResponse.json({ error: "Failed to load steps" }, { status: 500 });
  }
}
