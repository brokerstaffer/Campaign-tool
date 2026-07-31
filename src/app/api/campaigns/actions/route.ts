import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, verifySessionToken } from "@/lib/auth";
import { applyCampaignAction } from "@/lib/campaigns/actions.ts";
import { CAMPAIGN_ACTIONS } from "@/lib/campaigns/status.ts";

/*
 * One route for single and bulk actions alike — a single action is a batch of
 * one. Two routes would mean two copies of the auth check, the eligibility
 * check and the audit write, and the single-item path is the one that would
 * quietly drift.
 *
 * The response is always PER ITEM, even for one campaign, because pause/resume/
 * archive have no bulk endpoint upstream: a fan-out genuinely can half-succeed,
 * and "23 of 25 paused" is the only honest report.
 */

export const dynamic = "force-dynamic";
// A bulk action over every campaign is ~95 sequential-ish calls at concurrency
// 4. Well inside this, but the platform default would cut a large batch off
// midway — leaving some campaigns changed and the caller told nothing.
export const maxDuration = 300;

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

const Body = z.object({
  action: z.enum(CAMPAIGN_ACTIONS),
  campaignIds: z.array(z.number().int().positive()).min(1).max(500),
  /*
   * Required for anything that can start sending. The client sends it only from
   * a confirmation dialog that names the campaigns and their lead counts, so a
   * mis-wired fetch cannot resume 40 campaigns by accident. Spec §9: every
   * action is deliberate and confirmed.
   */
  confirm: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const session = await verifySessionToken(
    process.env.AUTH_SECRET ?? "",
    cookieStore.get(AUTH_COOKIE)?.value,
  );
  // The proxy already gates this path; reading the session here is for the
  // audit trail, which is worthless if it can't name who acted.
  if (!session?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { action, campaignIds, confirm } = parsed.data;

  if (action === "resume" && !confirm) {
    return NextResponse.json(
      {
        error:
          "Resume queues campaigns to send and must be confirmed. Re-send with confirm: true.",
      },
      { status: 428 },
    );
  }

  const { batchId, results } = await applyCampaignAction(
    action,
    campaignIds,
    session.email,
    TEAM_ID(),
  );

  const applied = results.filter((r) => r.ok).length;

  return NextResponse.json(
    {
      batchId,
      action,
      applied,
      failed: results.length - applied,
      results,
    },
    // 207: the batch was processed but not every item succeeded. A blanket 200
    // would let a caller that only checks response.ok report a half-done bulk
    // pause as done.
    { status: applied === results.length ? 200 : 207 },
  );
}
