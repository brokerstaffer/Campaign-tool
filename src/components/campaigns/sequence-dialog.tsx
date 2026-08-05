"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ExternalLink, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SequenceView,
  describeSequence,
  type SequenceStep,
} from "@/components/campaigns/sequence-view";

/*
 * The whole sequence behind an offer, without leaving Copy & Offer.
 *
 * The offer card said "Sequence: 3 steps from <campaign>" and stopped there, so
 * the only way to read the emails you were about to copy into other campaigns
 * was to leave, find the campaign, and open its Sequence tab. The thing you
 * most want before a one-click deploy is the copy itself.
 *
 * It reads the SAME endpoint the campaign detail page reads and renders it with
 * the SAME component, so the steps, the variants nested under them and the
 * waits between them cannot say one thing here and another there.
 */

interface CampaignDetail {
  campaign: { id: number; name: string; status: string };
  /* The route names it `sequence`, already nested — variants under the step
     they replace, orphans promoted. Same payload the campaign page renders. */
  sequence: SequenceStep[];
}

export function SequenceDialog({
  campaignId,
  campaignName,
  open,
  onOpenChange,
}: {
  campaignId: number | null;
  campaignName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery<CampaignDetail>({
    queryKey: ["campaign-detail", campaignId],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${campaignId}`);
      if (!response.ok) throw new Error("Could not load this sequence");
      return response.json();
    },
    // Only once it is actually opened — an offer grid is 20+ cards and
    // prefetching every sequence would be 20 requests for one you might read.
    enabled: open && campaignId != null,
    staleTime: 60_000,
  });

  const steps = data?.sequence ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4 text-left">
          <DialogTitle className="pr-6 text-base">{campaignName}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{steps.length ? describeSequence(steps) : "Sequence"}</span>
            {campaignId != null ? (
              <>
                <span aria-hidden>·</span>
                <Link
                  href={`/campaigns/${campaignId}`}
                  className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
                >
                  Open campaign
                  <ExternalLink className="size-3" />
                </Link>
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading sequence…
            </div>
          ) : error ? (
            <p className="py-12 text-center text-sm text-red-700">{(error as Error).message}</p>
          ) : steps.length ? (
            <SequenceView steps={steps} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              This campaign has no sequence steps cached.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
