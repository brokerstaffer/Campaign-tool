import type { EmailBisonClient } from "./client.ts";
import type { EBDailySeriesResponse } from "./types.ts";

/*
 * The daily-series adapter — the single most isolated module in the app.
 *
 * This is the ONLY place an EmailBison daily-series URL or label appears.
 * Swapping an endpoint, adding a scope, or absorbing a renamed label is a
 * one-line change here and nothing else moves.
 *
 * All three endpoints return the same envelope:
 *   data: [{ label, color, dates: [["2025-05-03", 0], ...] }]
 * so there is one parser and a dispatch table over scope.
 */

export type MetricKey =
  | "sent"
  | "replies"
  | "bounces"
  | "unsubscribes"
  | "positive"
  | "opens_total"
  | "opens_unique";

/**
 * EmailBison label → our metric key.
 *
 * An UNKNOWN label is logged and skipped, never silently dropped. That log line
 * is the drift detector: when EmailBison adds an eighth series, we find out
 * from a warning rather than from a number that quietly stops adding up.
 */
const METRIC_BY_LABEL: Record<string, MetricKey> = {
  Sent: "sent",
  Replied: "replies",
  Bounced: "bounces",
  Unsubscribed: "unsubscribes",
  Interested: "positive",
  "Total Opens": "opens_total",
  "Unique Opens": "opens_unique",
};

type Scope = "workspace" | "campaign" | "filtered";

const ENDPOINT: Record<Scope, (args: FetchArgs) => string> = {
  workspace: () => "/api/workspaces/v1.1/line-area-chart-stats",
  campaign: (args) =>
    `/api/campaigns/${args.campaignIds![0]}/line-area-chart-stats`,
  filtered: () => "/api/campaign-events/stats",
};

export interface FetchArgs {
  from: string;
  to: string;
  campaignIds?: number[];
  senderEmailIds?: number[];
}

/** One normalised point. Flat on purpose — this is exactly a table row. */
export interface DailyPoint {
  campaignId: number; // 0 = workspace-wide roll-up
  date: string; // YYYY-MM-DD
  metric: MetricKey;
  value: number;
}

/**
 * Picks the narrowest endpoint that can answer the question.
 *
 * `/api/campaign-events/stats` can do everything, but the single-campaign and
 * workspace endpoints are cheaper and are what EmailBison's own UI uses, so
 * they're likelier to stay correct.
 */
export function selectScope(args: FetchArgs): Scope {
  const hasSenderFilter = (args.senderEmailIds?.length ?? 0) > 0;
  const campaignCount = args.campaignIds?.length ?? 0;

  if (!hasSenderFilter && campaignCount === 0) return "workspace";
  if (!hasSenderFilter && campaignCount === 1) return "campaign";
  return "filtered";
}

function buildQuery(scope: Scope, args: FetchArgs): URLSearchParams {
  const query = new URLSearchParams({
    start_date: args.from,
    end_date: args.to,
  });

  if (scope === "filtered") {
    // Laravel expects repeated `key[]` params for array binding.
    for (const id of args.campaignIds ?? []) {
      query.append("campaign_ids[]", String(id));
    }
    for (const id of args.senderEmailIds ?? []) {
      query.append("sender_email_ids[]", String(id));
    }
  }

  return query;
}

/** Parses the shared envelope into flat rows. Exported for unit testing. */
export function parseDailySeries(
  response: EBDailySeriesResponse,
  campaignId: number,
): DailyPoint[] {
  const points: DailyPoint[] = [];
  const unknown = new Set<string>();

  for (const series of response.data ?? []) {
    const metric = METRIC_BY_LABEL[series.label];
    if (!metric) {
      unknown.add(series.label);
      continue;
    }

    for (const [date, value] of series.dates ?? []) {
      // A malformed tuple is skipped rather than written as NaN — one bad row
      // must not poison a whole day's chart.
      if (typeof date !== "string" || !Number.isFinite(Number(value))) continue;
      points.push({ campaignId, date, metric, value: Number(value) });
    }
  }

  if (unknown.size > 0) {
    console.warn(
      `[daily-series] unmapped EmailBison labels: ${[...unknown].join(", ")}. ` +
        `Add them to METRIC_BY_LABEL in src/lib/emailbison/daily-series.ts.`,
    );
  }

  return points;
}

/**
 * Fetches a daily series and returns flat, normalised rows.
 *
 * Returning DailyPoint[] rather than EmailBison's nested shape means the cron,
 * the backfill script, and any future replacement source all write identical
 * rows to eb_daily_series.
 */
export async function fetchDailySeries(
  client: EmailBisonClient,
  args: FetchArgs,
): Promise<DailyPoint[]> {
  const scope = selectScope(args);
  const path = ENDPOINT[scope](args);
  const response = await client.getDailySeries(path, buildQuery(scope, args));

  // Only the single-campaign scope can attribute rows to a campaign. The other
  // two are roll-ups and are stored under campaign_id 0.
  const campaignId = scope === "campaign" ? args.campaignIds![0] : 0;

  return parseDailySeries(response, campaignId);
}
