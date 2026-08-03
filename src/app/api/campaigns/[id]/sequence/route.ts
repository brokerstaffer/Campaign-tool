import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";

/*
 * Saving an edited sequence (spec §9.3).
 *
 * "Changes are saved only when you press Save. If you try to leave with unsaved
 * edits, you'll be warned. Nothing goes live by accident."
 *
 * The editor sends the WHOLE sequence as the user arranged it and this route
 * works out the three calls EmailBison actually needs, because it has no
 * save-my-sequence endpoint:
 *
 *   updates  -> PUT  /api/campaigns/v1.1/sequence-steps/{sequence_id}   (needs ids)
 *   adds     -> POST /api/campaigns/v1.1/{campaign_id}/sequence-steps   (appends)
 *   removals -> DELETE /api/campaigns/sequence-steps/{id}               (one each)
 *
 * Order matters. Updates run FIRST so a reorder lands even if a later add
 * fails, and deletes run LAST so a sequence is never briefly empty. Deleting a
 * step that has already sent is refused by EmailBison, so those are rejected
 * here with the reason rather than attempted.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Step = z.object({
  /** Absent = a new step. */
  id: z.number().int().positive().optional(),
  email_subject: z.string().max(500),
  email_body: z.string(),
  wait_in_days: z.number().int().min(0).max(365),
  thread_reply: z.boolean(),
  variant: z.boolean().default(false),
  variant_from_step_id: z.number().int().positive().nullable().optional(),
});

const Body = z.object({
  sequenceId: z.number().int().positive(),
  /** In final display order. `order` is derived from position, never trusted. */
  steps: z.array(Step).max(100),
});

/**
 * EmailBison owns the "Re: " prefix on threaded steps and re-adds it on every
 * write, so a subject round-tripped through the editor would gain one each
 * save. Verified: copying a threaded step produced "Re: Re: …".
 */
function bareSubject(subject: string, threadReply: boolean): string {
  return threadReply ? subject.replace(/^(?:re:\s*)+/i, "") : subject;
}

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
    return NextResponse.json(
      { error: "Invalid sequence", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { sequenceId, steps } = parsed.data;
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const teamId = TEAM_ID();

  const { data: campaign } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("id", campaignId)
    .eq("team_id", teamId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Read live, not from cache: the editor must diff against what EmailBison
  // has right now, or a step deleted upstream since the last sync is "removed"
  // again and a step added upstream is silently destroyed.
  let existing: Array<{ id: number; email_subject?: string; email_body?: string; order: number | string }>;
  try {
    const payload = await eb.getCampaignSequenceSteps(campaignId);
    existing = payload?.data?.sequence_steps ?? [];
  } catch (error) {
    const message = describeEmailBisonError(error);
    // A campaign with no sequence yet is the normal starting state, not a
    // fault: EmailBison reports it as an error rather than an empty list.
    if (/do not exist|not found/i.test(message)) {
      existing = [];
    } else {
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const keptIds = new Set(steps.map((s) => s.id).filter((v): v is number => v != null));
  const removed = existing.filter((s) => !keptIds.has(s.id));

  /*
   * EmailBison refuses to delete a step that has sent. Checking the local step
   * stats first turns "your save half-applied" into "you cannot remove this
   * step, and here is why" — before anything is written.
   */
  if (removed.length) {
    const { data: sent } = await sb
      .from("campaign_step_stats_daily")
      .select("sequence_step_id")
      .eq("campaign_id", campaignId)
      .gt("sent", 0);
    const hasVolume = new Set((sent ?? []).map((r) => r.sequence_step_id));
    const blocked = removed.filter((s) => hasVolume.has(s.id));

    if (blocked.length) {
      return NextResponse.json(
        {
          error:
            `${blocked.length} step(s) cannot be deleted because emails have already been sent for them. ` +
            `EmailBison does not allow this. Restore them and save again.`,
          blockedStepIds: blocked.map((s) => s.id),
        },
        { status: 409 },
      );
    }
  }

  const before = {
    steps: existing.map((s) => ({
      id: s.id,
      order: s.order,
      email_subject: s.email_subject,
      email_body: s.email_body,
    })),
  };

  const updates = steps
    .map((step, index) => ({ step, order: index + 1 }))
    .filter(({ step }) => step.id != null)
    .map(({ step, order }) => ({
      id: step.id,
      email_subject: bareSubject(step.email_subject, step.thread_reply),
      email_body: step.email_body,
      order,
      wait_in_days: step.wait_in_days,
      variant: step.variant,
      thread_reply: step.thread_reply,
      ...(step.variant && step.variant_from_step_id
        ? { variant_from_step_id: step.variant_from_step_id }
        : {}),
    }));

  const additions = steps
    .map((step, index) => ({ step, order: index + 1 }))
    .filter(({ step }) => step.id == null)
    .map(({ step, order }) => ({
      email_subject: bareSubject(step.email_subject, step.thread_reply),
      email_body: step.email_body,
      order,
      wait_in_days: step.wait_in_days,
      variant: step.variant,
      thread_reply: step.thread_reply,
    }));

  const applied = { updated: 0, added: 0, deleted: 0 };

  try {
    // 1. Updates first — a reorder survives a later failure.
    if (updates.length) {
      await eb.updateSequenceSteps(sequenceId, campaign.name, updates);
      applied.updated = updates.length;
    }
    // 2. Then additions.
    if (additions.length) {
      await eb.createSequenceSteps(campaignId, campaign.name, additions);
      applied.added = additions.length;
    }
    // 3. Deletes last, so the sequence is never briefly empty.
    for (const step of removed) {
      await eb.deleteSequenceStep(step.id);
      applied.deleted++;
    }
  } catch (error) {
    const message = describeEmailBisonError(error);
    await sb.from("campaign_audit_log").insert({
      team_id: teamId,
      campaign_id: campaignId,
      campaign_name: campaign.name,
      action: "edit-sequence",
      actor: session.email,
      status: "error",
      error: message,
      before_state: before,
      after_state: { partiallyApplied: applied },
    });
    return NextResponse.json(
      {
        error: message,
        // Naming what did land is the difference between "retry" and "check
        // what state this campaign is in first".
        partiallyApplied: applied,
      },
      { status: 502 },
    );
  }

  await sb.from("campaign_audit_log").insert({
    team_id: teamId,
    campaign_id: campaignId,
    campaign_name: campaign.name,
    action: "edit-sequence",
    actor: session.email,
    status: "ok",
    before_state: before,
    after_state: { ...applied, steps: steps.length },
  });

  return NextResponse.json({ ok: true, ...applied });
}
