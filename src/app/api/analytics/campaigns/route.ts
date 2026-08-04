import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const teamId = Number(process.env.EMAILBISON_TEAM_ID || 2);
  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  try {
    const { data, error } = await getSupabase().rpc("analytics_campaign_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    });
    if (error) throw new Error(error.message);

    const rows = (data ?? []).map((r: Record<string, unknown>) => ({
      campaignId: Number(r.campaign_id),
      campaignName: String(r.campaign_name),
      clientName: r.client_name as string | null,
      status: r.status as string | null,
      stepCount: Number(r.step_count),
      sent: Number(r.sent),
      prospects: Number(r.prospects),
      replies: Number(r.replies),
      humanReplies: Number(r.human_replies),
      positive: Number(r.positive),
      botReplies: Number(r.bot_replies),
      bounces: Number(r.bounces),
      medianReplySeconds:
        r.median_reply_seconds === null ? null : Number(r.median_reply_seconds),
      avgReplySeconds:
        r.avg_reply_seconds === null || r.avg_reply_seconds === undefined
          ? null
          : Number(r.avg_reply_seconds),
      bouncesHard: Number(r.bounces_hard ?? 0),
      bouncesSoft: Number(r.bounces_soft ?? 0),
      introductions: Number(r.introductions ?? 0),
      phoneScreens: Number(r.phone_screens ?? 0),
      interviews: Number(r.interviews ?? 0),
      hires: Number(r.hires ?? 0),
      outcomesTotal: Number(r.outcomes_total ?? 0),
    }));

    return NextResponse.json({ rows, count: rows.length });
  } catch (error) {
    console.error("[api/analytics/campaigns]", error);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
  }
}
