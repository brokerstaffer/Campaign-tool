"use client";

import { useQuery } from "@tanstack/react-query";
import { useAnalyticsFilters } from "./filters-context";
import {
  compactNumber,
  delta,
  duration,
  percent,
  ratio,
  type Delta,
} from "@/lib/analytics/format.ts";
import type { KpiCellData } from "./kpi-band";

/*
 * Fetches the KPI band and maps it to display cells.
 *
 * Formatting happens HERE, through format.ts, rather than on the server — so
 * the KPI band and the tables share one set of rules and `DASH` stays the only
 * way a nullish metric reaches the DOM.
 */

interface KpiValues {
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
}

interface KpiResponse {
  current: KpiValues;
  previous?: KpiValues;
  deltas?: Partial<Record<keyof KpiValues, number | null>>;
  coverage: {
    followUpBusinessHours: string | null;
    followUpSampleSize: number | null;
    replyTimingSampleSize: number;
  };
}

/**
 * Whether a rise is good news. Bounces going up is not a green number, and that
 * judgement belongs to the metric, not the formatter.
 */
const UP_IS_GOOD: Record<string, boolean> = {
  sent: true,
  prospects: true,
  replies: true,
  humanReplies: true,
  positive: true,
  bounces: false,
  medianReplyTime: false, // faster is better
  medianFollowUpTime: false,
  replyRate: true,
  humanRate: true,
  positiveRate: true,
  leadToEmail: false, // fewer emails per positive is better
};

export function useKpis() {
  const { toQueryString } = useAnalyticsFilters();
  const qs = toQueryString();

  const query = useQuery<KpiResponse>({
    queryKey: ["kpis", qs],
    queryFn: async () => {
      const response = await fetch(`/api/analytics/kpis${qs ? `?${qs}` : ""}`);
      if (!response.ok) throw new Error("Failed to load metrics");
      return response.json();
    },
  });

  const data = query.data;
  const deltaFor = (key: keyof KpiValues): Delta | null =>
    data?.deltas ? delta(data.deltas[key] ?? null) : null;

  const cell = (
    key: keyof KpiValues,
    label: string,
    value: string,
    note?: string,
  ): KpiCellData => ({
    key,
    label,
    value,
    delta: deltaFor(key),
    note,
    upIsGood: UP_IS_GOOD[key] ?? true,
  });

  const c = data?.current;

  const cells: KpiCellData[] = c
    ? [
        cell("sent", "Sent", compactNumber(c.sent)),
        cell("prospects", "Prospects", compactNumber(c.prospects)),
        cell("replies", "Replies", compactNumber(c.replies)),
        cell("humanReplies", "Human Replies", compactNumber(c.humanReplies)),
        cell("positive", "Positive", compactNumber(c.positive)),
        cell("bounces", "Bounces", compactNumber(c.bounces)),
        cell(
          "medianReplyTime",
          "Median Reply Time",
          duration(c.medianReplyTime),
          data?.coverage.replyTimingSampleSize
            ? `n=${data.coverage.replyTimingSampleSize}`
            : "no timing data yet",
        ),
        cell(
          "medianFollowUpTime",
          "Median Follow-up Time",
          duration(c.medianFollowUpTime),
          // Surfaced because this metric is business-hours adjusted while
          // Median Reply Time is raw elapsed time. Side by side they would
          // otherwise read as the same kind of measure.
          data?.coverage.followUpBusinessHours ? "business hours" : undefined,
        ),
        cell("replyRate", "Reply Rate", percent(c.replyRate)),
        cell("humanRate", "Human Rate", percent(c.humanRate)),
        cell("positiveRate", "Positive Rate", percent(c.positiveRate)),
        cell("leadToEmail", "Lead to Email", ratio(c.leadToEmail)),
      ]
    : [];

  return { cells, isLoading: query.isLoading, error: query.error };
}
