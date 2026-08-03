import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { describeEmailBisonError } from "@/lib/emailbison/errors.ts";
import { getSupabase } from "@/lib/supabase/server";
import type { EBSequenceStep } from "@/lib/emailbison/types.ts";

/*
 * Copying a sequence between campaigns (spec §9.4).
 *
 * "Written as a guided flow, because replacing a live campaign's emails is the
 * most consequential thing you can do here."
 *
 * The probe made that concrete. EmailBison has NO replace-a-sequence call:
 * PUT can only update steps that already exist and refuses to delete the ones
 * you omit. So Replace is delete-every-step-then-post-the-new-ones — several
 * calls, no transaction, and a window in which the target campaign has no
 * sequence at all.
 *
 * Which is why the order of operations below is not negotiable:
 *
 *   1. read the target's current steps
 *   2. WRITE THEM TO campaign_audit_log — before touching anything
 *   3. only then delete
 *   4. then post the new steps
 *
 * If step 4 fails, the emails are gone from EmailBison and the audit row is the
 * only copy that exists anywhere. That is the whole reason the spec asks for it.
 */

export type CopyMode = "replace" | "append";

export interface CopyOptions {
  includeVariants: boolean;
  includeAttachments: boolean;
}

export interface CopyPlanStep {
  order: number;
  subject: string | null;
  waitInDays: number | null;
  threadReply: boolean;
  isVariant: boolean;
  /** First line of the body, so the preview shows what actually gets sent. */
  opening: string | null;
}

export interface CopyPlan {
  sourceId: number;
  sourceName: string;
  targetId: number;
  targetName: string;
  targetStatus: string;
  mode: CopyMode;
  steps: CopyPlanStep[];
  /** What Replace would destroy. Empty for Append. */
  removing: CopyPlanStep[];
  /** Replace cannot proceed — at least one target step has already sent. */
  blocked: boolean;
  warnings: string[];
}

/*
 * EmailBison prepends "Re: " to the subject of any step with thread_reply.
 * Verified: posting "PROBE STEP 2" with thread_reply came back "Re: PROBE
 * STEP 2", and copying an already-threaded step produced "Re: Re: Join a
 * Zillow preferred brokerage?" — so a sequence copied twice grows a prefix
 * each time. EmailBison owns the prefix; we send the bare subject.
 */
function bareSubject(subject: string | null | undefined, threadReply: boolean): string | null {
  if (!subject) return subject ?? null;
  return threadReply ? subject.replace(/^(?:re:\s*)+/i, "") : subject;
}

/** Strips HTML to the first readable line, for the preview (§9.4). */
function opening(body: string | null | undefined): string | null {
  if (!body) return null;
  const text = body
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 120) : null;
}

function toPlanStep(step: EBSequenceStep): CopyPlanStep {
  return {
    order: Number(step.order) || 0,
    subject: step.email_subject ?? null,
    waitInDays: Number(step.wait_in_days) || null,
    threadReply: Boolean(step.thread_reply),
    isVariant: Boolean(step.variant),
    opening: opening(step.email_body),
  };
}

async function fetchSteps(campaignId: number): Promise<EBSequenceStep[]> {
  const eb = createEmailBisonClient();
  const payload = await eb.getCampaignSequenceSteps(campaignId);
  return payload?.data?.sequence_steps ?? [];
}

/*
 * The TARGET may legitimately have no sequence at all.
 *
 * EmailBison answers "Sequence steps do not exist for <name>" with HTTP 200 and
 * `{"data": {"success": false, ...}}` — NOT a 4xx. Verified against a campaign
 * created for the purpose. That shape is why assertApplied() exists: a status
 * check alone reads it as success and hands back an undefined step list.
 *
 * Propagating it as an error broke the single most important case this feature
 * exists for — pushing a proven offer into a freshly-created campaign. An empty
 * target is not a failure, it is the normal starting state.
 *
 * Only the target is treated this way. A SOURCE with no sequence really is
 * nothing to copy, and must still say so.
 */
async function fetchTargetSteps(campaignId: number): Promise<EBSequenceStep[]> {
  try {
    return await fetchSteps(campaignId);
  } catch (error) {
    const message = describeEmailBisonError(error).toLowerCase();
    if (message.includes("do not exist") || message.includes("not found")) return [];
    throw error;
  }
}

/** Builds the preview the operator confirms against. Reads only. */
export async function planCopy(
  sourceId: number,
  targetId: number,
  mode: CopyMode,
  options: CopyOptions,
  teamId: number,
): Promise<CopyPlan> {
  const sb = getSupabase();

  const [{ data: campaigns }, sourceSteps, targetSteps] = await Promise.all([
    sb.from("campaigns").select("id, name, status").eq("team_id", teamId).in("id", [sourceId, targetId]),
    fetchSteps(sourceId),
    fetchTargetSteps(targetId),
  ]);

  const source = campaigns?.find((c) => c.id === sourceId);
  const target = campaigns?.find((c) => c.id === targetId);
  if (!source) throw new Error(`Source campaign ${sourceId} is not in the local cache.`);
  if (!target) throw new Error(`Target campaign ${targetId} is not in the local cache.`);

  /*
   * EmailBison refuses to delete a step that has already sent: "The sequence
   * step can not be deleted as emails have already been sent out for it."
   *
   * That makes Replace impossible on most real campaigns, and finding out
   * halfway through a delete loop is the worst time to learn it. The local
   * step-stats cache already knows which steps have volume, so the preview can
   * say so before anything is touched.
   */
  const blocked = new Set<number>();
  if (mode === "replace" && targetSteps.length) {
    const { data: sent } = await sb
      .from("campaign_step_stats_daily")
      .select("sequence_step_id, sent")
      .eq("campaign_id", targetId)
      .gt("sent", 0);
    for (const row of sent ?? []) blocked.add(row.sequence_step_id);
  }

  const selected = options.includeVariants
    ? sourceSteps
    : sourceSteps.filter((s) => !s.variant);

  const warnings: string[] = [];

  if (["active", "queued", "launching"].includes(target.status)) {
    // The one that matters most: the target is sending RIGHT NOW.
    warnings.push(
      `"${target.name}" is ${target.status} — it is sending. Its next emails will use the new sequence.`,
    );
  }
  if (mode === "replace" && targetSteps.length) {
    const undeletable = targetSteps.filter((s) => blocked.has(s.id));
    if (undeletable.length) {
      // Not a warning — Replace simply cannot work here.
      warnings.push(
        `Replace will FAIL: ${undeletable.length} of these ${targetSteps.length} steps have already sent emails, and EmailBison refuses to delete those. Use Append instead.`,
      );
    } else {
      warnings.push(
        `EmailBison has no atomic replace. ${targetSteps.length} existing ${
          targetSteps.length === 1 ? "step" : "steps"
        } will be deleted before the new ones are created; if creation then fails, the campaign is left with no sequence. The old sequence is recorded in Activity first.`,
      );
    }
  }
  if (!options.includeVariants && sourceSteps.some((s) => s.variant)) {
    warnings.push(
      `${sourceSteps.filter((s) => s.variant).length} variant(s) will not be copied.`,
    );
  }
  if (options.includeAttachments && sourceSteps.some((s) => s.attachments)) {
    warnings.push("Attachments are copied by reference — verify them on the target afterwards.");
  }
  if (!selected.length) {
    warnings.push("The source has no steps to copy.");
  }

  return {
    sourceId,
    sourceName: source.name,
    targetId,
    targetName: target.name,
    targetStatus: target.status,
    mode,
    steps: selected.map(toPlanStep).sort((a, b) => a.order - b.order),
    removing: mode === "replace" ? targetSteps.map(toPlanStep).sort((a, b) => a.order - b.order) : [],
    blocked: targetSteps.some((s) => blocked.has(s.id)),
    warnings,
  };
}

export interface CopyOutcome {
  ok: boolean;
  created: number;
  deleted: number;
  error?: string;
  /** Set when the target was left without a sequence. Loud on purpose. */
  targetLeftEmpty?: boolean;
}

/**
 * Performs the copy.
 *
 * Variant handling: EmailBison accepts `variant_from_step` — an ORDER within
 * the same request — which is the only way to attach a variant to a step that
 * doesn't exist yet. Carrying the source's `variant_from_step_id` across would
 * point at a step in the SOURCE campaign, silently attaching the target's
 * variant to another campaign's step.
 */
export async function applyCopy(
  sourceId: number,
  targetId: number,
  mode: CopyMode,
  options: CopyOptions,
  actor: string,
  teamId: number,
): Promise<CopyOutcome> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();

  const [sourceSteps, targetSteps] = await Promise.all([
    fetchSteps(sourceId),
    fetchTargetSteps(targetId),
  ]);

  const { data: campaigns } = await sb
    .from("campaigns")
    .select("id, name")
    .eq("team_id", teamId)
    .in("id", [sourceId, targetId]);
  const target = campaigns?.find((c) => c.id === targetId);
  const source = campaigns?.find((c) => c.id === sourceId);

  const selected = (options.includeVariants ? sourceSteps : sourceSteps.filter((s) => !s.variant))
    .slice()
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));

  /*
   * THE SNAPSHOT. Written before a single destructive call, and containing the
   * full body of every step — not a summary. After the deletes below, this row
   * is the only place the target's previous emails still exist.
   */
  const { data: snapshot } = await sb
    .from("campaign_audit_log")
    .insert({
      team_id: teamId,
      campaign_id: targetId,
      campaign_name: target?.name ?? `#${targetId}`,
      action: "copy-sequence",
      actor,
      status: "ok",
      before_state: {
        mode,
        from: { id: sourceId, name: source?.name ?? null },
        previousSequence: targetSteps.map((s) => ({
          id: s.id,
          order: s.order,
          email_subject: s.email_subject,
          email_body: s.email_body,
          wait_in_days: s.wait_in_days,
          variant: s.variant,
          variant_from_step_id: s.variant_from_step_id,
          thread_reply: s.thread_reply,
        })),
      },
      after_state: null,
    })
    .select("id")
    .single();

  let deleted = 0;
  try {
    if (mode === "replace") {
      // Serial, not concurrent: a partial failure should stop rather than
      // race ahead and delete more than it can report.
      for (const step of targetSteps) {
        await eb.deleteSequenceStep(step.id);
        deleted++;
      }
    }

    const offset = mode === "append" ? targetSteps.length : 0;
    const orderOf = new Map<number, number>();
    selected.forEach((step, index) => orderOf.set(step.id, offset + index + 1));

    const payload = selected.map((step) => {
      const body: Record<string, unknown> = {
        email_subject: bareSubject(step.email_subject, Boolean(step.thread_reply)),
        email_body: step.email_body,
        order: orderOf.get(step.id),
        wait_in_days: Number(step.wait_in_days) || 0,
        variant: Boolean(step.variant),
        thread_reply: Boolean(step.thread_reply),
      };
      if (options.includeAttachments && step.attachments) {
        body.attachments = step.attachments;
      }
      if (step.variant && step.variant_from_step_id != null) {
        // Order within THIS request, never the source's step id.
        const parentOrder = orderOf.get(step.variant_from_step_id);
        if (parentOrder) body.variant_from_step = parentOrder;
        else body.variant = false; // parent wasn't copied; keep it as a plain step
      }
      return body;
    });

    if (payload.length) {
      await eb.createSequenceSteps(targetId, target?.name ?? "Sequence", payload);
    }

    if (snapshot?.id) {
      await sb
        .from("campaign_audit_log")
        .update({ after_state: { created: payload.length, deleted, mode } })
        .eq("id", snapshot.id);
    }

    return { ok: true, created: payload.length, deleted };
  } catch (error) {
    const message = describeEmailBisonError(error);
    // Deleted something and then failed to create → the target has no sequence.
    const targetLeftEmpty = mode === "replace" && deleted > 0;

    if (snapshot?.id) {
      await sb
        .from("campaign_audit_log")
        .update({
          status: "error",
          error: targetLeftEmpty
            ? `${message} — ${deleted} step(s) were already deleted, so this campaign now has NO sequence. Its previous steps are in before_state on this row.`
            : message,
          after_state: { created: 0, deleted, mode },
        })
        .eq("id", snapshot.id);
    }

    return { ok: false, created: 0, deleted, error: message, targetLeftEmpty };
  }
}
