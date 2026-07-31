import { randomUUID } from "node:crypto";
import { createEmailBisonClient } from "@/lib/emailbison/client.ts";
import { EmailBisonApiError } from "@/lib/emailbison/client.ts";
import { getSupabase } from "@/lib/supabase/server";
import { canApply, whyNot, type CampaignAction } from "./status.ts";

/*
 * Applying campaign actions.
 *
 * Three rules, all from spec §9 ("every action is deliberate, confirmed, and
 * recorded") and §9.5 ("if a change can't be applied on the sending platform,
 * the dashboard says so with the actual reason, and does not show the change as
 * saved"):
 *
 *  1. EmailBison decides. The local row is updated only AFTER a 2xx, so the UI
 *     can never show a state the sending platform doesn't have.
 *  2. Every attempt is logged, including failures — a refused pause is exactly
 *     the event someone will come looking for.
 *  3. A bulk action is a fan-out that reports PER ITEM. Pause, resume and
 *     archive have no bulk endpoint, so "23 of 25 paused" is the honest answer
 *     and a single ok/failed for the batch is not.
 */

export interface ActionResult {
  campaignId: number;
  name: string;
  ok: boolean;
  /** Present on success — what EmailBison reports the status is now. */
  status?: string;
  /** Present on failure — the platform's actual words, never a generic message. */
  error?: string;
  /** True when the action was refused locally and never reached EmailBison. */
  skipped?: boolean;
}

interface CampaignRow {
  id: number;
  name: string;
  status: string;
  total_leads: number | null;
}

/** Status after each action, when EmailBison doesn't return the campaign. */
const RESULTING_STATUS: Record<CampaignAction, string | null> = {
  pause: "paused",
  // resume returns the campaign, so this is only a fallback; `queued` is what
  // it was observed to produce, NOT the previous status.
  resume: "queued",
  archive: "archived",
  duplicate: null, // the source campaign is unchanged
};

async function applyOne(
  eb: ReturnType<typeof createEmailBisonClient>,
  action: CampaignAction,
  campaign: CampaignRow,
): Promise<{ result: ActionResult; after: string | null }> {
  if (!canApply(action, campaign.status)) {
    // Refused here rather than sent and rejected: a round trip that we already
    // know will fail is a round trip that might instead unexpectedly succeed.
    return {
      result: {
        campaignId: campaign.id,
        name: campaign.name,
        ok: false,
        skipped: true,
        error: whyNot(action, campaign.status),
      },
      after: null,
    };
  }

  try {
    let status: string | null = RESULTING_STATUS[action];

    switch (action) {
      case "pause":
        await eb.pauseCampaign(campaign.id);
        break;
      case "resume": {
        const response = await eb.resumeCampaign(campaign.id);
        status = response?.data?.status ?? status;
        break;
      }
      case "archive":
        await eb.archiveCampaign(campaign.id);
        break;
      case "duplicate":
        await eb.duplicateCampaign(campaign.id);
        break;
    }

    return {
      result: { campaignId: campaign.id, name: campaign.name, ok: true, status: status ?? undefined },
      after: action === "duplicate" ? null : status,
    };
  } catch (error) {
    // EmailBisonApiError carries the platform's own body. That is what §9.5
    // requires be shown — not "something went wrong".
    const message =
      error instanceof EmailBisonApiError
        ? describe(error)
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      result: { campaignId: campaign.id, name: campaign.name, ok: false, error: message },
      after: null,
    };
  }
}

/** Pulls the human-readable reason out of EmailBison's error body. */
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

/**
 * Applies one action to many campaigns.
 *
 * Concurrency 4 matches the EmailBison rate limiter the read jobs use — a bulk
 * pause over 90 campaigns should not be the thing that gets the API key
 * throttled mid-sweep.
 */
export async function applyCampaignAction(
  action: CampaignAction,
  campaignIds: number[],
  actor: string,
  teamId: number,
): Promise<{ batchId: string; results: ActionResult[] }> {
  const sb = getSupabase();
  const eb = createEmailBisonClient();
  const batchId = randomUUID();

  const { data: rows } = await sb
    .from("campaigns")
    .select("id, name, status, total_leads")
    .eq("team_id", teamId)
    .in("id", campaignIds);

  const byId = new Map((rows ?? []).map((r) => [r.id, r as CampaignRow]));

  const results: ActionResult[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const statusWrites: Array<{ id: number; status: string }> = [];

  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, campaignIds.length) }, async () => {
      while (cursor < campaignIds.length) {
        const id = campaignIds[cursor++];
        const campaign = byId.get(id);

        if (!campaign) {
          // Not in our cache — refuse rather than guess. A campaign we've never
          // synced is one whose status we cannot check `canApply` against.
          results.push({
            campaignId: id,
            name: `#${id}`,
            ok: false,
            skipped: true,
            error: "Unknown campaign — not in the local cache. Run sync-entities.",
          });
          continue;
        }

        const { result, after } = await applyOne(eb, action, campaign);
        results.push(result);

        // Skipped attempts never reached EmailBison, so they are not history.
        if (!result.skipped) {
          auditRows.push({
            team_id: teamId,
            campaign_id: campaign.id,
            campaign_name: campaign.name,
            action,
            actor,
            status: result.ok ? "ok" : "error",
            error: result.error ?? null,
            before_state: { status: campaign.status, total_leads: campaign.total_leads },
            after_state: result.ok ? { status: after ?? campaign.status } : null,
            batch_id: batchId,
          });
        }

        if (result.ok && after) statusWrites.push({ id: campaign.id, status: after });
      }
    }),
  );

  /*
   * Write the new status straight into the cache instead of waiting for
   * sync-entities. Without this the row snaps back to its old status on the
   * next refetch and reads as "the action didn't work" for up to 30 minutes.
   */
  await Promise.all([
    auditRows.length ? sb.from("campaign_audit_log").insert(auditRows) : Promise.resolve(),
    ...statusWrites.map((w) =>
      sb.from("campaigns").update({ status: w.status }).eq("id", w.id),
    ),
  ]);

  // Stable order out, whatever order the pool finished in.
  const order = new Map(campaignIds.map((id, i) => [id, i]));
  results.sort((a, b) => (order.get(a.campaignId) ?? 0) - (order.get(b.campaignId) ?? 0));

  return { batchId, results };
}
