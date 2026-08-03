import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase/server";
import { resolveFilters, toISODate } from "@/lib/analytics/query-params.ts";
import { COPY_DIMENSION_KEYS, isCopyDimension } from "@/lib/analytics/copy-dimensions.ts";

/*
 * Copy performance (spec §6.1), grouped by ONE OR MORE dimensions.
 *
 * The screenshot's control is `Dimension: [picker] [chip ✕] [+ Add Dimension]`,
 * so the grouping is a SET, not a single choice, and the number of value
 * combinations is not knowable in SQL ahead of time. This route therefore asks
 * the database for per-step rows with their tags attached and forms the
 * combinations here.
 *
 * That is the app's one exemption from "aggregate in SQL", and it is bounded on
 * purpose: the row count is the number of sequence steps with volume in range
 * (233 today) and grows with campaigns, not with sending. The per-day stats
 * behind every row are still summed in SQL, so the PostgREST 1000-row cap this
 * rule exists to dodge is not reachable by data growth.
 */

export const dynamic = "force-dynamic";

const TEAM_ID = () => Number(process.env.EMAILBISON_TEAM_ID || 2);

interface StepRow {
  sequence_step_id: number;
  campaign_id: number;
  campaign_name: string | null;
  offer_id: string | null;
  subject: string | null;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  tags: Record<string, string>;
}

const UNTAGGED = "Untagged";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("dimensions") ?? "subject_line";
  const dimensions = raw.split(",").map((d) => d.trim()).filter(Boolean);

  if (!dimensions.length || !dimensions.every(isCopyDimension)) {
    return NextResponse.json(
      { error: `dimensions must be a comma-separated subset of: ${COPY_DIMENSION_KEYS.join(", ")}` },
      { status: 400 },
    );
  }

  let filters;
  try {
    filters = resolveFilters(request.nextUrl.searchParams, toISODate(new Date()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid filters" },
      { status: 400 },
    );
  }

  const offerId = request.nextUrl.searchParams.get("offer_id");

  const { data, error } = await getSupabase().rpc("analytics_copy_steps", {
    p_team_id: TEAM_ID(),
    p_from: filters.from,
    p_to: filters.to,
    p_client_ids: filters.clientIds.length ? filters.clientIds : null,
    p_campaign_ids: filters.campaignIds.length ? filters.campaignIds : null,
  });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const steps = ((data ?? []) as StepRow[]).filter(
    (s) => !offerId || s.offer_id === offerId,
  );

  interface Bucket {
    key: string;
    values: string[];
    steps: number;
    sent: number;
    replies: number;
    positive: number;
    bounced: number;
    untagged: boolean;
  }
  const buckets = new Map<string, Bucket>();

  for (const step of steps) {
    /*
     * A step missing a tag on a selected dimension becomes "Untagged" rather
     * than being dropped. Dropping it would quietly remove its volume from the
     * table while the totals elsewhere still counted it, and the reader would
     * have no way to see that the comparison was partial.
     */
    const values = dimensions.map((d) => step.tags?.[d] ?? UNTAGGED);
    const key = values.join(" › ");

    const bucket = buckets.get(key) ?? {
      key,
      values,
      steps: 0,
      sent: 0,
      replies: 0,
      positive: 0,
      bounced: 0,
      untagged: values.includes(UNTAGGED),
    };
    bucket.steps += 1;
    bucket.sent += Number(step.sent) || 0;
    bucket.replies += Number(step.replies) || 0;
    bucket.positive += Number(step.positive) || 0;
    bucket.bounced += Number(step.bounced) || 0;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()]
    .map((b) => ({
      ...b,
      // NULL, never 0, when nothing was sent — "no data" and "0%" are different
      // facts and DASH is how the first one reaches the DOM.
      reply_rate: b.sent > 0 ? b.replies / b.sent : null,
      positive_rate: b.replies > 0 ? b.positive / b.replies : null,
      bounce_rate: b.sent > 0 ? b.bounced / b.sent : null,
    }))
    .sort((a, b) => b.sent - a.sent);

  const taggedSent = steps
    .filter((s) => dimensions.every((d) => s.tags?.[d]))
    .reduce((sum, s) => sum + (Number(s.sent) || 0), 0);
  const totalSent = steps.reduce((sum, s) => sum + (Number(s.sent) || 0), 0);

  return NextResponse.json({
    dimensions,
    from: filters.from,
    to: filters.to,
    rows,
    coverage: {
      tagged_sent: taggedSent,
      total_sent: totalSent,
      tagged_steps: steps.filter((s) => dimensions.every((d) => s.tags?.[d])).length,
      total_steps: steps.length,
    },
  });
}
