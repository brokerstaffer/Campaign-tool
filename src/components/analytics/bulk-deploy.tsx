"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, RotateCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/*
 * Pushing one sequence into many campaigns.
 *
 * Every task is a separate write to EmailBison against a live campaign, so this
 * is built around the assumption that some of them WILL fail — a target whose
 * steps have already sent cannot be replaced, and a campaign deleted upstream
 * cannot be written to at all. The shape follows from that:
 *
 *  - RUN THEM ONE AT A TIME. Concurrency would finish sooner and would also
 *    mean several half-applied sequences at once when the API starts refusing.
 *    Serial keeps every failure isolated and the audit log readable.
 *  - NEVER STOP THE BATCH ON A FAILURE. One target refusing says nothing about
 *    the next; stopping would turn one bad campaign into thirty unattempted.
 *  - KEEP THE REAL ERROR PER TARGET. A count of failures is not actionable —
 *    "this one has already sent" and "this one no longer exists" need different
 *    responses, and the panel shows each verbatim.
 *  - RETRY ONLY WHAT FAILED. Re-running the successes would append the sequence
 *    a second time, which is silent duplication rather than a no-op.
 */

export type TaskStatus = "pending" | "running" | "ok" | "error";

export interface DeployTask {
  campaignId: number;
  name: string;
  status: TaskStatus;
  error?: string;
  created?: number;
  deleted?: number;
  /** True when a partial write left the campaign without a sequence. */
  leftEmpty?: boolean;
}

export interface DeployBatch {
  sourceCampaignId: number;
  sourceLabel: string;
  mode: "append" | "replace";
  tasks: DeployTask[];
}

async function runOne(
  sourceCampaignId: number,
  mode: "append" | "replace",
  targetId: number,
): Promise<Partial<DeployTask>> {
  const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sourceCampaignId,
      mode,
      includeVariants: true,
      includeAttachments: true,
      apply: true,
    }),
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      status: "error",
      error: body.error ?? `Request failed (${response.status})`,
      leftEmpty: Boolean(body.targetLeftEmpty),
    };
  }
  return { status: "ok", created: body.created ?? 0, deleted: body.deleted ?? 0 };
}

export function useBulkDeploy() {
  const queryClient = useQueryClient();
  const [batch, setBatch] = useState<DeployBatch | null>(null);
  const [running, setRunning] = useState(false);

  const process = useCallback(
    async (current: DeployBatch, only?: number[]) => {
      setRunning(true);
      const targets = current.tasks.filter(
        (t) => (only ? only.includes(t.campaignId) : true) && t.status !== "ok",
      );

      for (const task of targets) {
        setBatch((b) =>
          b
            ? {
                ...b,
                tasks: b.tasks.map((t) =>
                  t.campaignId === task.campaignId
                    ? { ...t, status: "running", error: undefined }
                    : t,
                ),
              }
            : b,
        );

        let result: Partial<DeployTask>;
        try {
          result = await runOne(current.sourceCampaignId, current.mode, task.campaignId);
        } catch (error) {
          // A network failure is not a refusal — say so, and leave it retryable.
          result = {
            status: "error",
            error: error instanceof Error ? error.message : "Network error",
          };
        }

        setBatch((b) =>
          b
            ? {
                ...b,
                tasks: b.tasks.map((t) =>
                  t.campaignId === task.campaignId ? { ...t, ...result } : t,
                ),
              }
            : b,
        );
      }

      setRunning(false);
      void queryClient.invalidateQueries({ queryKey: ["campaign"] });
      void queryClient.invalidateQueries({ queryKey: ["offers"] });
    },
    [queryClient],
  );

  const start = useCallback(
    (next: DeployBatch) => {
      setBatch(next);
      void process(next);
    },
    [process],
  );

  const retryFailed = useCallback(() => {
    if (!batch) return;
    const failed = batch.tasks.filter((t) => t.status === "error").map((t) => t.campaignId);
    if (failed.length) void process(batch, failed);
  }, [batch, process]);

  return { batch, running, start, retryFailed, dismiss: () => setBatch(null) };
}

/** The panel. Sticky at the top of the page while a batch runs. */
export function BulkDeployPanel({
  batch,
  running,
  onRetry,
  onDismiss,
}: {
  batch: DeployBatch | null;
  running: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  if (!batch) return null;

  const done = batch.tasks.filter((t) => t.status === "ok").length;
  const failed = batch.tasks.filter((t) => t.status === "error");
  const total = batch.tasks.length;
  const pct = Math.round(((done + failed.length) / total) * 100);

  return (
    <div className="sticky top-0 z-20 rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : failed.length ? (
          <AlertTriangle className="size-4 shrink-0 text-[#b02525]" />
        ) : (
          <Check className="size-4 shrink-0 text-emerald-600" />
        )}

        <div className="min-w-0">
          <p className="text-sm font-medium">
            {running ? "Copying" : failed.length ? "Finished with errors" : "Copied"}{" "}
            &ldquo;{batch.sourceLabel}&rdquo; to {total}{" "}
            {total === 1 ? "campaign" : "campaigns"}
          </p>
          <p className="tnum text-xs text-muted-foreground">
            {done} succeeded
            {failed.length ? ` · ${failed.length} failed` : ""}
            {running ? ` · ${total - done - failed.length} remaining` : ""} · {batch.mode}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {!running && failed.length ? (
            <Button variant="outline" size="sm" onClick={onRetry} className="h-8 gap-1.5 text-xs">
              <RotateCw className="size-3" />
              Retry {failed.length} failed
            </Button>
          ) : null}
          {!running ? (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="h-1 w-full bg-muted">
        <div
          className={cn(
            "h-full transition-[width]",
            failed.length ? "bg-[#d03b3b]" : "bg-emerald-600",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Only the failures get listed. Thirty green rows push the two that need
          a human off the screen, which defeats the panel. */}
      {failed.length ? (
        <ul className="max-h-56 divide-y overflow-y-auto">
          {failed.map((task) => (
            <li key={task.campaignId} className="px-4 py-2">
              <p className="truncate text-xs font-medium" title={task.name}>
                {task.name}
              </p>
              <p className="text-xs text-[#b02525]">{task.error}</p>
              {task.leftEmpty ? (
                <p className="text-xs font-medium text-[#b02525]">
                  This campaign now has NO sequence — its previous steps are in its Activity
                  tab.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {running ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          {/* Says why it is not instant, so a slow batch does not read as a hang. */}
          Run one at a time so a failure never leaves several campaigns half-written.
        </p>
      ) : null}
    </div>
  );
}
