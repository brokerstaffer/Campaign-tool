"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Attach this campaign to an offer (spec §6.2: "attach it to any campaign").
 *
 * The endpoint has existed since the offers work; nothing ever called it. The
 * only way to attach a campaign was to create an offer FROM it, so an existing
 * offer could never pick up a second campaign — which is precisely the case
 * that makes offer-level analysis worth having.
 *
 * Writes immediately rather than behind a Save button. This is a reporting
 * label, not sequence content: it changes what a chart groups by, never what a
 * prospect receives. §9.3's "nothing goes live by accident" is about the
 * sequence editor, and applying it here would only add a click.
 */

interface Offer {
  id: string;
  name: string;
  niche: string | null;
}

interface OffersResponse {
  offers: Offer[];
  rows: Array<{ offer_id: string; offer_name: string }>;
}

export function OfferPicker({ campaignId }: { campaignId: number }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<OffersResponse>({
    queryKey: ["offers", "picker"],
    queryFn: async () => {
      const response = await fetch("/api/offers");
      if (!response.ok) throw new Error("Failed to load offers");
      return response.json();
    },
    staleTime: 60_000,
  });

  const { data: current } = useQuery<{ offerId: string | null }>({
    queryKey: ["campaign-offer", campaignId],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${campaignId}`);
      if (!response.ok) throw new Error("Failed to load campaign");
      const body = await response.json();
      return { offerId: body.campaign?.offer_id ?? body.offer_id ?? null };
    },
  });

  const save = useMutation({
    mutationFn: async (offerId: string | null) => {
      const response = await fetch(`/api/campaigns/${campaignId}/offer`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save the offer");
      return body;
    },
    onSuccess: () => {
      // The offer tables group by this, so they are stale the moment it changes.
      for (const key of ["offers", "campaign-offer", "copy", "offer-suggestions"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  if (isLoading) {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }

  const offers = data?.offers ?? [];
  const selected = save.isPending ? save.variables : (current?.offerId ?? null);

  if (!offers.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No offers exist yet. Create one on the Copy &amp; Offer tab, then attach it here.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Offer"
          value={selected ?? ""}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.value || null)}
          className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm sm:max-w-sm"
        >
          <option value="">No offer</option>
          {offers.map((offer) => (
            <option key={offer.id} value={offer.id}>
              {offer.name}
              {offer.niche ? ` · ${offer.niche}` : ""}
            </option>
          ))}
        </select>

        {save.isPending ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : save.isSuccess ? (
          <span className="flex items-center gap-1 text-xs text-emerald-700">
            <Check className="size-3" />
            Saved
          </span>
        ) : null}
      </div>

      {save.error ? (
        <p className={cn("text-xs text-red-700")}>{save.error.message}</p>
      ) : null}
    </div>
  );
}
