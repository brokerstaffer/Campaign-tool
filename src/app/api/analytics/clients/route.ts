import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  positiveRate,
  replyRate,
} from "@/lib/analytics/metrics.ts";

export const dynamic = "force-dynamic";

interface Row {
  client_id: string | null;
  client_name: string;
  campaign_count: number;
  ambiguous_count: number;
  sent: number;
  prospects: number;
  replies: number;
  human_replies: number;
  positive: number;
  bounces: number;
  median_reply_seconds: number | null;
}

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
    const { data, error } = await getSupabase().rpc("analytics_client_rows", {
      p_team_id: teamId,
      p_from: filters.from,
      p_to: filters.to,
      p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
      p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    });
    if (error) throw new Error(error.message);

    const rows = ((data ?? []) as Row[]).map((r) => {
      const sent = Number(r.sent);
      const replies = Number(r.replies);
      const positive = Number(r.positive);
      return {
        clientId: r.client_id,
        name: r.client_name,
        campaignCount: Number(r.campaign_count),
        ambiguousCount: Number(r.ambiguous_count),
        sent,
        prospects: Number(r.prospects),
        replies,
        humanReplies: Number(r.human_replies),
        positive,
        bounces: Number(r.bounces),
        // Derived here, from the SAME functions the KPI band uses, so a client
        // row and the tile above it can never disagree on a formula.
        replyRate: replyRate(replies, sent),
        humanRate: humanRate(Number(r.human_replies), sent),
        positiveRate: positiveRate(positive, replies),
        leadToEmail: leadToEmail(sent, positive),
        bounceRate: bounceRate(Number(r.bounces), sent),
        medianReplySeconds:
          r.median_reply_seconds === null ? null : Number(r.median_reply_seconds),
      };
    });

    // Totals are summed from the SAME rows the table renders, not queried
    // separately -- so the footer can never disagree with what's above it.
    const sum = (k: "sent" | "prospects" | "replies" | "humanReplies" | "positive" | "bounces") =>
      rows.reduce((t, r) => t + r[k], 0);

    return NextResponse.json({
      rows,
      totals: {
        sent: sum("sent"),
        prospects: sum("prospects"),
        replies: sum("replies"),
        humanReplies: sum("humanReplies"),
        positive: sum("positive"),
        bounces: sum("bounces"),
      },
      count: rows.length,
    });
  } catch (error) {
    console.error("[api/analytics/clients]", error);
    return NextResponse.json({ error: "Failed to load clients" }, { status: 500 });
  }
}
