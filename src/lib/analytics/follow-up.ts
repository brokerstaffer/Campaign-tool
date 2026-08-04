/*
 * Median Follow-up Time — how long WE take to answer once a prospect replies.
 * A measure of the team, not the copy (WT §4).
 *
 * THE PORTAL IS THE ONLY SOURCE, and that is not a preference. The team answers
 * from the portal inbox rather than from EmailBison, so EmailBison's
 * conversation-thread carries no follow-up at all — sampled 12 human replies
 * older than 20 days and every one had zero newer messages. `first_followup_at`
 * on `replies` is NULL for all 8,000+ rows for the same reason.
 *
 * The portal exposes `overall`, `days`, and (since 2026-08-05) `by_campaign`,
 * which is what makes the per-campaign column possible.
 */

/** Same 5-minute TTL as the other live upstreams; see kpis.ts. */
const TTL_SECONDS = 300;

/**
 * Below this many samples a "median" is just one person's reply time.
 *
 * 26 of 71 campaigns are under it on the live feed, and the values there are
 * exactly what you would expect from noise — 2m from a single reply next to 22h
 * from another single reply. Rendering those as a campaign's typical speed would
 * invite someone to act on one person's lunch break, so they return null and
 * reach the DOM as DASH.
 *
 * The same discipline as the copy medals, which need 500 sends before ranking.
 */
export const FOLLOW_UP_MIN_SAMPLE = 5;

export interface FollowUpOverall {
  seconds: number | null;
  sampleSize: number | null;
  businessHours: string | null;
}

interface PortalResponse {
  overall?: { median_seconds?: number | null; sample_size?: number | null };
  business_hours?: string | null;
  by_campaign?: Array<{
    campaign_id?: number;
    median_seconds?: number | null;
    sample_size?: number | null;
  }>;
}

/**
 * One fetch, both answers.
 *
 * Returns nulls rather than throwing: this is one tile and one column out of
 * many, and an upstream outage should degrade them to a dash, not blank the
 * page around them.
 */
async function fetchPortal(from: string, to: string): Promise<PortalResponse | null> {
  const base = process.env.PORTAL_BASE_URL;
  const token = process.env.PORTAL_TOKEN;
  if (!base || !token) return null;

  try {
    const response = await fetch(
      `${base.replace(/\/$/, "")}/api/metrics/follow-up-time?from=${from}&to=${to}&token=${token}`,
      { next: { revalidate: TTL_SECONDS } },
    );
    /*
     * The portal host rewrites blocked /api/* to an HTML page with status 200,
     * so `ok` alone is not proof — check the content type before parsing, or a
     * login page becomes a metric.
     */
    const type = response.headers.get("content-type") ?? "";
    if (!response.ok || !type.includes("application/json")) return null;
    return (await response.json()) as PortalResponse;
  } catch {
    return null;
  }
}

export async function fetchFollowUpOverall(
  from: string,
  to: string,
): Promise<FollowUpOverall> {
  const body = await fetchPortal(from, to);
  return {
    seconds: body?.overall?.median_seconds ?? null,
    sampleSize: body?.overall?.sample_size ?? null,
    businessHours: body?.business_hours ?? null,
  };
}

/**
 * Per-campaign medians, keyed by EmailBison campaign id.
 *
 * Campaigns under FOLLOW_UP_MIN_SAMPLE are omitted entirely rather than
 * included with a small number, so a caller cannot accidentally render one.
 */
export async function fetchFollowUpByCampaign(
  from: string,
  to: string,
): Promise<Map<number, { seconds: number; sampleSize: number }>> {
  const body = await fetchPortal(from, to);
  const out = new Map<number, { seconds: number; sampleSize: number }>();

  for (const row of body?.by_campaign ?? []) {
    const id = Number(row.campaign_id);
    const seconds = Number(row.median_seconds);
    const sampleSize = Number(row.sample_size);
    if (!Number.isInteger(id) || !Number.isFinite(seconds)) continue;
    if (!Number.isFinite(sampleSize) || sampleSize < FOLLOW_UP_MIN_SAMPLE) continue;
    out.set(id, { seconds, sampleSize });
  }

  return out;
}
