"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { CampaignMultiPicker } from "@/components/analytics/campaign-multi-picker";

/*
 * Push THIS campaign's sequence into others.
 *
 * The mirror of "Copy sequence from…", and the direction people actually want
 * once a campaign is working: roll the proven opener out to the rest. Before
 * this, the only way to do that was from an offer card, which meant creating an
 * offer purely to reuse a sequence.
 *
 * It previews every target rather than the first, because with Replace the
 * answer genuinely differs per campaign — one may have nothing to delete while
 * the next has a step that has already sent and cannot be touched.
 */

export function PushSequenceDialog({
  sourceId,
  sourceName,
  stepCount,
  open,
  onOpenChange,
  onStart,
}: {
  sourceId: number;
  sourceName: string;
  stepCount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: (batch: {
    sourceCampaignId: number;
    sourceLabel: string;
    mode: "append" | "replace";
    tasks: Array<{ campaignId: number; name: string; status: "pending" }>;
  }) => void;
}) {
  const [targetIds, setTargetIds] = useState<number[]>([]);
  const [mode, setMode] = useState<"append" | "replace">("append");

  const campaigns = useQuery<{ items: Array<{ id: number; name: string }> }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: open,
    staleTime: 60_000,
  });

  const plans = useQuery({
    queryKey: ["push-plan", sourceId, targetIds, mode],
    queryFn: async () =>
      Promise.all(
        targetIds.map(async (targetId) => {
          const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sourceCampaignId: sourceId,
              mode,
              includeVariants: true,
              includeAttachments: true,
              apply: false,
            }),
          });
          const body = await response.json().catch(() => ({}));
          return {
            targetId,
            ok: response.ok,
            plan: body.plan as
              | { steps: unknown[]; removing: unknown[]; blocked: boolean; warnings: string[] }
              | undefined,
            error: body.error as string | undefined,
          };
        }),
      ),
    enabled: open && targetIds.length > 0,
  });

  const nameOf = (id: number) =>
    campaigns.data?.items.find((c) => c.id === id)?.name ?? `#${id}`;

  const blocked = (plans.data ?? []).filter((p) => !p.ok || p.plan?.blocked);
  const ready = (plans.data ?? []).filter((p) => p.ok && !p.plan?.blocked);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Push this sequence to other campaigns</DialogTitle>
        </DialogHeader>

        <div className="min-w-0 space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {stepCount} steps from <span className="text-foreground">{sourceName}</span>
          </p>

          <div>
            <span className="text-xs font-medium">Target campaigns</span>
            <div className="mt-1">
              <CampaignMultiPicker
                value={targetIds}
                onChange={setTargetIds}
                exclude={sourceId}
              />
            </div>
          </div>

          <div className="flex gap-3 text-xs">
            {(["append", "replace"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  className="accent-foreground"
                />
                <span className="capitalize">{m}</span>
              </label>
            ))}
          </div>

          {plans.isFetching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Checking {targetIds.length} {targetIds.length === 1 ? "campaign" : "campaigns"}…
            </p>
          ) : null}

          {ready.length ? (
            <p className="rounded-md border bg-muted/40 p-2 text-xs">
              <strong className="font-medium">{ready.length}</strong> ready
              {mode === "replace"
                ? ` · ${ready.reduce((n, p) => n + (p.plan?.removing.length ?? 0), 0)} existing steps will be deleted`
                : ""}
            </p>
          ) : null}

          {blocked.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-[#b02525]">
                {blocked.length} will be skipped
              </p>
              <ul className="max-h-28 space-y-1 overflow-y-auto rounded-md border border-red-300/60 bg-red-50/50 p-2 text-xs">
                {blocked.map((p) => (
                  <li key={p.targetId}>
                    <span className="block truncate font-medium">{nameOf(p.targetId)}</span>
                    <span className="block text-[#b02525]">
                      {p.error ?? p.plan?.warnings[0] ?? "Cannot be written to"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={mode === "replace" ? "destructive" : "default"}
            disabled={!ready.length || plans.isFetching}
            onClick={() => {
              onStart({
                sourceCampaignId: sourceId,
                sourceLabel: sourceName,
                mode,
                tasks: ready.map((p) => ({
                  campaignId: p.targetId,
                  name: nameOf(p.targetId),
                  status: "pending" as const,
                })),
              });
              onOpenChange(false);
              setTargetIds([]);
            }}
          >
            {mode === "replace" ? "Replace in" : "Push to"} {ready.length}{" "}
            {ready.length === 1 ? "campaign" : "campaigns"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
