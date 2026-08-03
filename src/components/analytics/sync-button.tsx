"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Pull campaigns from EmailBison now, rather than waiting for the 30-minute
 * cron.
 *
 * The gap this closes is specific: create a campaign in EmailBison, come here,
 * and it is not in the picker — while a campaign deleted minutes ago still is.
 * Both are correct behaviour for a cache and both look like bugs.
 */
export function SyncButton({
  job = "sync-entities",
  label = "Sync campaigns",
  invalidate = ["campaigns", "offers", "offer-suggestions"],
}: {
  job?: string;
  label?: string;
  invalidate?: string[];
}) {
  const queryClient = useQueryClient();

  const run = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/sync/run?job=${job}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Sync failed");
      return body as {
        status: string;
        detail?: { campaigns?: number; markedDeleted?: number; restored?: number };
      };
    },
    onSuccess: () => {
      for (const key of invalidate) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const detail = run.data?.detail;

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={run.isPending}
        onClick={() => run.mutate()}
        className="h-8 gap-1.5 text-sm"
        title="Fetch campaigns from EmailBison now instead of waiting for the next scheduled sync"
      >
        <RefreshCw className={cn("size-3.5", run.isPending && "animate-spin")} />
        {run.isPending ? "Syncing…" : label}
      </Button>

      {/* Say what changed. "Synced" with no number cannot be told from a no-op,
          which is exactly the doubt this button exists to remove. */}
      {run.isSuccess && !run.isPending ? (
        run.data?.status === "skipped" ? (
          <span className="text-xs text-muted-foreground">
            a scheduled sync is already running
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-emerald-700">
            <Check className="size-3" />
            {detail?.campaigns ?? 0} campaigns
            {detail?.markedDeleted ? `, ${detail.markedDeleted} removed` : ""}
            {detail?.restored ? `, ${detail.restored} restored` : ""}
          </span>
        )
      ) : null}

      {run.error ? (
        <span className="text-xs text-red-700">{run.error.message}</span>
      ) : null}
    </div>
  );
}
