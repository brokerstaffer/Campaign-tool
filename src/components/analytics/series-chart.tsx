"use client";

import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { SERIES, type SeriesKey } from "@/lib/analytics/series.ts";
import { compactNumber, percent } from "@/lib/analytics/format.ts";

export interface Point {
  date: string;
  sent: number;
  prospects: number;
  replies: number;
  human: number;
  positive: number;
  bounces: number;
}

interface Props {
  points: Point[];
  compare?: Point[];
  selected: SeriesKey[];
  mode: "volume" | "rates";
  normalize: boolean;
  loading?: boolean;
}

/** `2026-07-28` -> `Jul 28`. Parsed as UTC so the label can't drift a day. */
function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * In Rates mode each series becomes a percentage of the day's Sent — except
 * Positive, which is a share of Replies. That mirrors the KPI band, where
 * Positive Rate is over Replies and everything else is over Sent; the chart
 * disagreeing with the tiles would be worse than the extra branch here.
 */
function toRate(point: Point, key: SeriesKey): number | null {
  if (key === "positive") {
    return point.replies > 0 ? point.positive / point.replies : null;
  }
  const denominator = point.sent;
  if (!denominator) return null;
  const value = point[key as keyof Point];
  return typeof value === "number" ? value / denominator : null;
}

export function SeriesChart({
  points,
  compare,
  selected,
  mode,
  normalize,
  loading,
}: Props) {
  const data = useMemo(() => {
    // Peak per series, for Normalize. Computed over the CURRENT period only so
    // the comparison overlay stays on the same scale rather than rescaling the
    // chart it is being compared against.
    const peaks: Partial<Record<SeriesKey, number>> = {};
    for (const key of selected) {
      peaks[key] = Math.max(
        1,
        ...points.map((p) =>
          mode === "rates" ? (toRate(p, key) ?? 0) : Number(p[key as keyof Point] ?? 0),
        ),
      );
    }

    const value = (p: Point | undefined, key: SeriesKey) => {
      if (!p) return null;
      const raw = mode === "rates" ? toRate(p, key) : Number(p[key as keyof Point] ?? 0);
      if (raw === null) return null;
      return normalize ? (raw / (peaks[key] || 1)) * 100 : raw;
    };

    return points.map((p, index) => {
      const row: Record<string, unknown> = { date: p.date, _raw: p };
      for (const key of selected) {
        row[key] = value(p, key);
        // Zipped by index, not by date: the comparison period has different
        // dates, and the point of the overlay is "same position in the window".
        row[`${key}__cmp`] = compare ? value(compare[index], key) : null;
        row[`${key}__cmpRaw`] = compare?.[index] ?? null;
      }
      row._cmpDate = compare?.[index]?.date ?? null;
      return row;
    });
  }, [points, compare, selected, mode, normalize]);

  if (loading) return <Skeleton className="h-[320px] w-full" />;

  if (!points.length) {
    return (
      <div className="flex h-[320px] items-center justify-center rounded-lg border border-dashed">
        <p className="text-xs text-muted-foreground">No data in this period.</p>
      </div>
    );
  }

  const formatValue = (v: number | null) => {
    if (v === null || v === undefined) return "-";
    if (normalize) return `${Math.round(v)}`;
    return mode === "rates" ? percent(v, 2) : compactNumber(v);
  };

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          {selected.map((key) => (
            <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[key].color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={SERIES[key].color} stopOpacity={0.01} />
            </linearGradient>
          ))}
        </defs>

        <CartesianGrid stroke="var(--hairline)" vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={shortDate}
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          minTickGap={24}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v) =>
            normalize
              ? String(v)
              : mode === "rates"
                ? percent(v, 1)
                : compactNumber(v)
          }
        />

        <Tooltip
          cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          contentStyle={{
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0].payload as Record<string, unknown>;
            return (
              <div className="rounded-lg border bg-card p-2.5 text-xs shadow-sm">
                <p className="mb-1.5 font-medium">{shortDate(String(label))}</p>
                {/* Every ACTIVE series is listed, not just the hovered one —
                    the point of a crosshair is comparing them on one day. */}
                {selected.map((key) => (
                  <div key={key} className="flex items-center gap-2 py-0.5">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: SERIES[key].color }}
                    />
                    <span className="flex-1 text-muted-foreground">
                      {SERIES[key].label}
                    </span>
                    <span className="tnum font-medium">
                      {formatValue(row[key] as number | null)}
                    </span>
                    {compare ? (
                      <span className="tnum w-14 text-right text-muted-foreground/70">
                        {formatValue(row[`${key}__cmp`] as number | null)}
                      </span>
                    ) : null}
                  </div>
                ))}
                {compare && row._cmpDate ? (
                  <p className="mt-1.5 border-t pt-1.5 text-[11px] text-muted-foreground/70">
                    vs {shortDate(String(row._cmpDate))}
                  </p>
                ) : null}
              </div>
            );
          }}
        />

        {selected.map((key) => (
          <Area
            key={`area-${key}`}
            type="monotone"
            dataKey={key}
            stroke="none"
            fill={`url(#fill-${key})`}
            isAnimationActive={false}
            connectNulls
          />
        ))}

        {/* Comparison drawn UNDER the current period and dashed, so it reads as
            background reference rather than a competing series. */}
        {compare
          ? selected.map((key) => (
              <Line
                key={`cmp-${key}`}
                type="monotone"
                dataKey={`${key}__cmp`}
                stroke={SERIES[key].color}
                strokeWidth={1.5}
                strokeDasharray="3 3"
                strokeOpacity={0.35}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            ))
          : null}

        {selected.map((key) => (
          <Line
            key={`line-${key}`}
            type="monotone"
            dataKey={key}
            stroke={SERIES[key].color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
