"use client";

import { useQuery } from "@tanstack/react-query";

interface Credits {
  used: number;
  total: number;
}

/*
 * The reference shows a credits bar (83% · 248.1K / 300.0K · "Each credit = 1
 * email"). Whether EmailBison exposes this, and where from, is an open question
 * (Q13).
 *
 * So this renders NOTHING until the endpoint returns real data. A hardcoded
 * placeholder would be a number on a dashboard that isn't true, which is worse
 * than an absent widget — nobody distrusts a widget they can't see.
 */
export function CreditsMeter() {
  const { data } = useQuery<Credits | null>({
    queryKey: ["credits"],
    queryFn: async () => {
      const response = await fetch("/api/workspace/credits");
      if (!response.ok) return null;
      return response.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  if (!data || !data.total) return null;

  const pct = Math.min(100, Math.round((data.used / data.total) * 100));

  return (
    <div className="space-y-1.5 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        Credits
      </p>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-success transition-[width] duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="tnum text-[11px] text-muted-foreground">{pct}%</span>
      </div>
      <p className="tnum text-[11px] text-muted-foreground/70">
        {data.used.toLocaleString()} / {data.total.toLocaleString()} credits
      </p>
    </div>
  );
}
