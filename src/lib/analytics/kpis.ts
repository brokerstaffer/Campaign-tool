import { getSupabase } from "@/lib/supabase/server";
import {
  bounceRate,
  humanRate,
  leadToEmail,
  periodDelta,
  positiveRate,
  replyRate,
} from "./metrics.ts";
import type { ResolvedFilters } from "./query-params.ts";

/*
 * Assembles the KPI band from three sources, because no single one has all of it:
 *
 *   analytics_kpis          the six counts (Sent, Prospects, Replies, Human,
 *                           Positive, Bounces), both periods in one call
 *   analytics_reply_timing  Median Reply Time, from replies with a resolved
 *                           first-send timestamp
 *   portal follow-up API    Median Follow-up Time — a business-hours-adjusted
 *                           median computed upstream
 *
 * Rates are derived here from the counts rather than computed in SQL, so the
 * formulas live in metrics.ts once and the RPC only has to return integers.
 */

export interface KpiValues {
  sent: number;
  prospects: number;
  replies: number;
  humanReplies: number;
  positive: number;
  bounces: number;
  medianReplyTime: number | null;
  medianFollowUpTime: number | null;
  replyRate: number | null;
  humanRate: number | null;
  positiveRate: number | null;
  leadToEmail: number | null;
  bounceRate: number | null;
}

export interface KpiResponse {
  current: KpiValues;
  previous?: KpiValues;
  deltas?: Partial<Record<keyof KpiValues, number | null>>;
  compareLabel?: { from: string; to: string };
  coverage: {
    /** Median Follow-up Time is business-hours adjusted; Reply Time is not. */
    followUpBusinessHours: string | null;
    followUpSampleSize: number | null;
    replyTimingSampleSize: number;
  };
}

interface RpcRow {
  period: string;
  sent: number;
  prospects: number;
  replies: number;
  human_replies: number;
  positive: number;
  bounces: number;
}

function derive(
  row: RpcRow | undefined,
  prospects: number | null,
  medianReply: number | null,
  medianFollowUp: number | null,
): KpiValues {
  const sent = Number(row?.sent ?? 0);
  const replies = Number(row?.replies ?? 0);
  const humanReplies = Number(row?.human_replies ?? 0);
  const positive = Number(row?.positive ?? 0);
  const bounces = Number(row?.bounces ?? 0);

  return {
    sent,
    // NOT row.prospects -- that column sums daily distinct counts and
    // overcounts. See fetchProspects().
    prospects: prospects ?? 0,
    replies,
    humanReplies,
    positive,
    bounces,
    medianReplyTime: medianReply,
    medianFollowUpTime: medianFollowUp,
    replyRate: replyRate(replies, sent),
    humanRate: humanRate(humanReplies, sent),
    positiveRate: positiveRate(positive, replies),
    leadToEmail: leadToEmail(sent, positive),
    bounceRate: bounceRate(bounces, sent),
  };
}

/**
 * Prospects = DISTINCT leads contacted in the range.
 *
 * This CANNOT be a sum of the daily values. `total_leads_contacted` is itself a
 * distinct count per day, so a lead emailed on eight days contributes eight
 * times. Over 62 days that inflated Prospects to ~= Sent, which is nonsense.
 *
 * EmailBison computes the distinct count correctly for any range, so ask it
 * once. Unfiltered that is a single workspace call; filtered it is one call per
 * selected campaign, which is why the campaign picker should stay narrow.
 *
 * Note the residual caveat when filtering: per-campaign distinct counts still
 * double-count a lead that appears in two selected campaigns. EmailBison
 * exposes no cross-campaign distinct count, so that is a genuine upstream
 * limit, not something to paper over.
 */
async function fetchProspects(
  from: string,
  to: string,
  campaignIds: number[],
): Promise<number | null> {
  const base = process.env.EMAILBISON_BASE_URL;
  const key = process.env.EMAILBISON_API_KEY;
  if (!base || !key) return null;

  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  try {
    if (campaignIds.length === 0) {
      const response = await fetch(
        `${base}/api/workspaces/v1.1/stats?start_date=${from}&end_date=${to}`,
        { headers, cache: "no-store" },
      );
      if (!response.ok) return null;
      const body = await response.json();
      return Number(body?.data?.total_leads_contacted ?? 0);
    }

    // Cap the fan-out: beyond this the latency is worse than the precision is
    // worth, and the caller is better served by a narrower filter.
    const targets = campaignIds.slice(0, 25);
    const results = await Promise.all(
      targets.map(async (id) => {
        const response = await fetch(`${base}/api/campaigns/${id}/stats`, {
          method: "POST",
          headers,
          body: JSON.stringify({ start_date: from, end_date: to }),
          cache: "no-store",
        });
        if (!response.ok) return 0;
        const body = await response.json();
        return Number(body?.data?.total_leads_contacted ?? 0);
      }),
    );
    return results.reduce((total, n) => total + n, 0);
  } catch {
    return null;
  }
}

/**
 * Median Follow-up Time from the portal.
 *
 * Returns null rather than throwing: this is one tile out of twelve, and an
 * upstream outage should degrade it to a dash, not blank the whole band.
 */
async function fetchFollowUpTime(
  from: string,
  to: string,
): Promise<{ seconds: number | null; sampleSize: number | null; businessHours: string | null }> {
  const base = process.env.PORTAL_BASE_URL;
  const token = process.env.PORTAL_TOKEN;
  if (!base || !token) {
    return { seconds: null, sampleSize: null, businessHours: null };
  }

  try {
    const response = await fetch(
      `${base}/api/metrics/follow-up-time?from=${from}&to=${to}&token=${token}`,
      { cache: "no-store" },
    );
    // The portal host rewrites blocked /api/* to an HTML page with status 200,
    // so ok alone is not proof — check the content type before parsing.
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.includes("application/json")) {
      return { seconds: null, sampleSize: null, businessHours: null };
    }
    const body = await response.json();
    return {
      seconds: body?.overall?.median_seconds ?? null,
      sampleSize: body?.overall?.sample_size ?? null,
      businessHours: body?.business_hours ?? null,
    };
  } catch {
    return { seconds: null, sampleSize: null, businessHours: null };
  }
}

export async function loadKpis(
  filters: ResolvedFilters,
  teamId: number,
): Promise<KpiResponse> {
  const sb = getSupabase();

  const args = {
    p_team_id: teamId,
    p_from: filters.from,
    p_to: filters.to,
    p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
  };

  const [counts, timing, followUp, prospects, previousTiming, previousFollowUp, previousProspects] =
    await Promise.all([
      sb.rpc("analytics_kpis", { ...args, p_compare: filters.compare }),
      sb.rpc("analytics_reply_timing", args),
      fetchFollowUpTime(filters.from, filters.to),
      fetchProspects(filters.from, filters.to, filters.campaignIds),
      filters.compare && filters.compareFrom && filters.compareTo
        ? sb.rpc("analytics_reply_timing", {
            ...args,
            p_from: filters.compareFrom,
            p_to: filters.compareTo,
          })
        : Promise.resolve(null),
      filters.compare && filters.compareFrom && filters.compareTo
        ? fetchFollowUpTime(filters.compareFrom, filters.compareTo)
        : Promise.resolve(null),
      filters.compare && filters.compareFrom && filters.compareTo
        ? fetchProspects(filters.compareFrom, filters.compareTo, filters.campaignIds)
        : Promise.resolve(null),
    ]);

  if (counts.error) throw new Error(`analytics_kpis: ${counts.error.message}`);

  const rows = (counts.data ?? []) as RpcRow[];
  const currentRow = rows.find((r) => r.period === "current");
  const previousRow = rows.find((r) => r.period === "previous");

  const medianReply = timing.data?.[0]?.median_reply_seconds ?? null;
  const replySamples = Number(timing.data?.[0]?.sample_size ?? 0);

  const current = derive(
    currentRow,
    prospects,
    medianReply === null ? null : Number(medianReply),
    followUp.seconds,
  );

  const response: KpiResponse = {
    current,
    coverage: {
      followUpBusinessHours: followUp.businessHours,
      followUpSampleSize: followUp.sampleSize,
      replyTimingSampleSize: replySamples,
    },
  };

  if (filters.compare && previousRow) {
    const previousMedian = previousTiming?.data?.[0]?.median_reply_seconds ?? null;
    const previous = derive(
      previousRow,
      previousProspects,
      previousMedian === null ? null : Number(previousMedian),
      previousFollowUp?.seconds ?? null,
    );

    response.previous = previous;
    response.compareLabel = {
      from: filters.compareFrom!,
      to: filters.compareTo!,
    };
    response.deltas = Object.fromEntries(
      (Object.keys(current) as Array<keyof KpiValues>).map((key) => [
        key,
        periodDelta(current[key], previous[key]),
      ]),
    ) as KpiResponse["deltas"];
  }

  return response;
}
