"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

/*
 * The staleness strip.
 *
 * Every number on this dashboard is a cached copy of EmailBison. When a sync
 * stops, nothing breaks visibly — the charts still draw, the KPIs still read
 * plausible, and they are simply wrong by however long the outage has run. This
 * strip is the only thing standing between that and a decision made on last
 * week's data.
 *
 * It renders NOTHING when healthy, and nothing while loading. A banner that is
 * usually present is a banner nobody sees.
 */

interface SyncStatus {
  healthy: boolean;
  degraded: string[];
  jobs: Array<{ job: string; status: string; lastSuccessAt: string | null }>;
}

function agoLabel(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / (60 * 24))}d ago`;
}

export function StalenessStrip() {
  const { data } = useQuery<SyncStatus>({
    queryKey: ["sync-status"],
    queryFn: async () => {
      const response = await fetch("/api/sync/status");
      if (!response.ok) throw new Error("status unavailable");
      return response.json();
    },
    refetchInterval: 5 * 60_000,
    // A failed health check is not itself evidence of stale data, so it stays
    // silent rather than crying wolf.
    retry: 1,
  });

  if (!data || data.healthy) return null;

  const worst = data.jobs
    .filter((j) => data.degraded.includes(j.job))
    .sort((a, b) => (a.lastSuccessAt ?? "").localeCompare(b.lastSuccessAt ?? ""))[0];

  return (
    <div className="flex items-center gap-2 border-b border-amber-300/60 bg-amber-50 px-6 py-1.5 text-xs text-amber-900">
      <AlertTriangle className="size-3.5 shrink-0" />
      <span>
        Data may be stale — {worst?.job ?? "a sync"} last succeeded{" "}
        {agoLabel(worst?.lastSuccessAt ?? null)}
      </span>
      {data.degraded.length > 1 ? (
        <span className="text-amber-700/80">
          ({data.degraded.length} jobs affected)
        </span>
      ) : null}
    </div>
  );
}
