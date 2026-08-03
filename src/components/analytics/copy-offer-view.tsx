"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAnalyticsFilters } from "@/components/analytics/filters-context";
import {
  COPY_DIMENSIONS, awardMedals, dimensionLabel, MEDAL_MIN_SENT,
} from "@/lib/analytics/copy-dimensions.ts";
import { compactNumber, fullNumber, percent } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * Copy & Offer (spec §6), built to the reference screenshot.
 *
 * Offer groups sit on top as cards — one per offer, each carrying its combined
 * stats and the copy dimensions its sequence uses — with a dashed "Add Group"
 * card at the end. Below them a `Dimension:` row with removable chips and
 * "+ Add Dimension", then the performance table for whatever set is selected.
 *
 * The reframe, on the product owner's direction: an offer is not a label on
 * some campaigns, it is a REUSABLE SEQUENCE plus the evidence for it. Every
 * card can therefore push its sequence into another campaign in one click,
 * reusing the guided copy flow from §9.4 — including its audit snapshot and its
 * refusal to delete steps that have already sent.
 */

interface OfferRow {
  offer_id: string;
  offer_name: string;
  niche: string | null;
  campaigns: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
  source: { source_campaign_id: number; source_name: string; step_count: number } | null;
}

interface CopyRow {
  key: string;
  values: string[];
  steps: number;
  sent: number;
  replies: number;
  positive: number;
  bounced: number;
  untagged: boolean;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface Suggestion {
  fingerprint: string;
  example_subject: string;
  variants: number;
  campaigns: number;
  campaign_ids: number[];
  source_campaign_id: number;
  source_name: string;
  step_count: number;
  claimed: number;
  sent: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface CopyResponse {
  dimensions: string[];
  rows: CopyRow[];
  coverage: {
    tagged_sent: number; total_sent: number; tagged_steps: number; total_steps: number;
  };
}

export function CopyOfferView() {
  // The same shared filter contract every analytics tab reads, so the date
  // range and client selection above apply here without a second parser.
  const { toQueryString } = useAnalyticsFilters();
  const queryClient = useQueryClient();

  const [dimensions, setDimensions] = useState<string[]>(["subject_line"]);
  const [creating, setCreating] = useState(false);
  const [deploying, setDeploying] = useState<OfferRow | null>(null);

  const query = toQueryString();

  const suggestions = useQuery<{ suggestions: Suggestion[] }>({
    queryKey: ["offer-suggestions", query],
    queryFn: async () => {
      const response = await fetch(`/api/offers/suggestions?${query}`);
      if (!response.ok) throw new Error("Could not load suggestions");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const offers = useQuery<{ rows: OfferRow[] }>({
    queryKey: ["offers", query],
    queryFn: async () => {
      const response = await fetch(`/api/offers?${query}`);
      if (!response.ok) throw new Error("Could not load offers");
      return response.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const copy = useQuery<CopyResponse>({
    queryKey: ["copy", query, dimensions],
    queryFn: async () => {
      const response = await fetch(`/api/copy?${query}&dimensions=${dimensions.join(",")}`);
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not load copy");
      return response.json();
    },
    enabled: dimensions.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const rows = copy.data?.rows ?? [];
  /*
   * Untagged is a gap in the data, not a copy choice, so it cannot win a medal
   * — and being the largest bucket by volume it would take one every time until
   * tagging is done. It still appears in the table, because dropping it would
   * hide how partial the comparison is.
   */
  const medals = awardMedals(rows.filter((r) => !r.untagged));
  const coverage = copy.data?.coverage;
  const coverPct =
    coverage && coverage.total_sent > 0 ? coverage.tagged_sent / coverage.total_sent : null;

  const unused = COPY_DIMENSIONS.filter((d) => !dimensions.includes(d.key));

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
      <div className="space-y-5 p-6">
        {/* ---- Offer groups: only once at least one exists ---- */}
        {(offers.data?.rows?.length ?? 0) > 0 ? (
        <section>
          <div className="mb-3 flex items-baseline gap-3">
            <h2 className="text-base font-semibold tracking-tight">Offers</h2>
            <p className="text-sm text-muted-foreground">
              Combined performance, and the sequence behind each one
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {(offers.data?.rows ?? []).map((offer) => (
              <div key={offer.offer_id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={offer.offer_name}>
                      {offer.offer_name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {offer.niche ?? "No niche set"} · {offer.campaigns}{" "}
                      {offer.campaigns === 1 ? "campaign" : "campaigns"}
                    </p>
                  </div>
                </div>

                {offer.source ? (
                  <p className="mt-2 truncate text-xs text-muted-foreground">
                    Sequence: {offer.source.step_count} steps from{" "}
                    <span className="text-foreground">{offer.source.source_name}</span>
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No campaign attached yet — nothing to copy from.
                  </p>
                )}

                <dl className="mt-4 grid grid-cols-4 gap-2 text-center">
                  {(
                    [
                      ["Sent", compactNumber(offer.sent), ""],
                      ["Reply", percent(offer.reply_rate, 1), ""],
                      ["Positive", percent(offer.positive_rate, 1), "text-emerald-700"],
                      ["Bounce", percent(offer.bounce_rate, 1), ""],
                    ] as const
                  ).map(([label, value, tone]) => (
                    <div key={label}>
                      <dd className={cn("tnum text-sm font-semibold", tone)}>{value}</dd>
                      <dt className="text-[11px] text-muted-foreground">{label}</dt>
                    </div>
                  ))}
                </dl>

                <Button
                  variant="outline"
                  size="sm"
                  disabled={!offer.source}
                  onClick={() => setDeploying(offer)}
                  className="mt-4 h-8 w-full gap-1.5 text-xs"
                >
                  <Send className="size-3" />
                  Copy sequence to a campaign
                </Button>
              </div>
            ))}

            {/* The dashed "Add Group" card from the reference. */}
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex min-h-[180px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <Plus className="size-5" />
              <span className="text-sm">Add Group</span>
            </button>
          </div>
        </section>
        ) : null}

        {/*
          * Proposed groups, discovered from the data.
          *
          * Campaigns that open with the same email ARE the same offer, and the
          * workspace already contains 36 on one subject and 24 on another.
          * Shipping an empty "Add Group" card asked the operator to reassemble
          * by hand something the database can see. Naming is the only part a
          * human is genuinely needed for, so that is the only part left to do.
          */}
        {(suggestions.data?.suggestions?.length ?? 0) > 0 ? (
          <section>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-base font-semibold tracking-tight">Suggested groups</h2>
              <p className="text-sm text-muted-foreground">
                Campaigns that open with the same email — name one to turn it into an offer
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreating(true)}
                className="ml-auto h-8 gap-1.5 text-sm"
              >
                <Plus className="size-3.5" />
                Add Group
              </Button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {suggestions.data!.suggestions.slice(0, 8).map((s) => (
                <SuggestionCard
                  key={s.fingerprint}
                  suggestion={s}
                  onCreated={() => {
                    void queryClient.invalidateQueries({ queryKey: ["offers"] });
                    void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
                  }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {/* ---- Copy dimensions ---- */}
        <section>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Dimension:</span>

            {dimensions.map((key) => (
              <span
                key={key}
                className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-sm shadow-sm"
              >
                {dimensionLabel(key)}
                <button
                  type="button"
                  aria-label={`Remove ${dimensionLabel(key)}`}
                  // Never remove the last one: an empty selection has no table
                  // to show, and a screen that can be emptied into nothing reads
                  // as broken rather than as a choice.
                  disabled={dimensions.length === 1}
                  onClick={() => setDimensions(dimensions.filter((d) => d !== key))}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}

            {unused.length ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm">
                    <Plus className="size-3.5" />
                    Add Dimension
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-64">
                  {unused.map((d) => (
                    <DropdownMenuItem
                      key={d.key}
                      onSelect={() => setDimensions([...dimensions, d.key])}
                      className="flex-col items-start gap-0.5"
                    >
                      <span className="text-sm">{d.label}</span>
                      <span className="text-xs text-muted-foreground">{d.hint}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {copy.isFetching ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}

            {coverPct === 0 ? (
              <SuggestTagsButton
                onDone={() => {
                  void queryClient.invalidateQueries({ queryKey: ["copy"] });
                  void queryClient.invalidateQueries({ queryKey: ["copy-tags"] });
                }}
              />
            ) : null}

            {coverPct != null ? (
              <p
                className={cn(
                  "ml-auto text-sm",
                  coverPct < 0.5 ? "text-amber-700" : "text-muted-foreground",
                )}
              >
                {/*
                  * Coverage, always. A ranking computed over a fraction of
                  * sending that presents itself as "how your copy performs" is
                  * worse than an empty table.
                  */}
                {percent(coverPct, 0)} of first-email sending tagged on{" "}
                {dimensions.length === 1 ? "this dimension" : "all these dimensions"}
              </p>
            ) : null}
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  {dimensions.map((key) => (
                    <th key={key} className="px-4 py-2.5 font-medium">
                      {dimensionLabel(key)}
                    </th>
                  ))}
                  <th className="w-[9%] px-3 py-2.5 text-right font-medium">Steps</th>
                  <th className="w-[11%] px-3 py-2.5 text-right font-medium">Sent</th>
                  <th className="w-[11%] px-3 py-2.5 text-right font-medium">Replies</th>
                  <th className="w-[10%] px-3 py-2.5 text-right font-medium">Reply&nbsp;%</th>
                  <th className="w-[12%] px-3 py-2.5 text-right font-medium">Positive&nbsp;%</th>
                  <th className="w-[11%] px-4 py-2.5 text-right font-medium">Bounce&nbsp;%</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {copy.isLoading ? (
                  <tr>
                    <td colSpan={dimensions.length + 5} className="py-16 text-center">
                      <Loader2 className="mx-auto size-4 animate-spin text-muted-foreground" />
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={dimensions.length + 5}
                      className="px-4 py-16 text-center text-muted-foreground"
                    >
                      No data matches your criteria.
                      <span className="mt-1 block text-xs">
                        Tag a sequence step&apos;s copy dimensions from the Sequence tab of any
                        campaign, and it will appear here.
                      </span>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const medal = medals.get(row);
                    return (
                      <tr key={row.key} className="transition-colors hover:bg-muted/50">
                        {row.values.map((value, i) => (
                          <td key={i} className="truncate px-4 py-2.5" title={value}>
                            {i === 0 && medal ? <span className="mr-1.5">{medal}</span> : null}
                            <span
                              className={cn(
                                value === "Untagged"
                                  ? "italic text-muted-foreground"
                                  : "font-medium",
                              )}
                            >
                              {value}
                            </span>
                          </td>
                        ))}
                        <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                          {fullNumber(row.steps)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">{fullNumber(row.sent)}</td>
                        <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                          {fullNumber(row.replies)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
                          {percent(row.reply_rate, 2)}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right font-medium">
                          {percent(row.positive_rate, 2)}
                        </td>
                        {/* A high bounce rate is coloured so a bad performer
                            cannot hide behind a decent reply rate (§6.1). */}
                        <td
                          className={cn(
                            "tnum px-4 py-2.5 text-right",
                            (row.bounce_rate ?? 0) >= 0.03 ? "font-medium text-[#b02525]" : "",
                          )}
                        >
                          {percent(row.bounce_rate, 2)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/*
            * The scope note is not a footnote people can skip: the numbers here
            * are deliberately smaller than the campaign totals, and without
            * this the difference reads as a bug.
            */}
          <p className="mt-2 text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">First email only.</strong> Follow-ups
            are excluded: EmailBison inherits their subject from the step above, so counting them
            would count the same subject two or three times, and their replies belong to the
            opener that preceded them. Variants of the first email are included. Sorted by volume;
            medals mark the best positive rate among values with at least{" "}
            {fullNumber(MEDAL_MIN_SENT)} sends, because without a floor the smallest sample wins
            every time.
          </p>
        </section>
      </div>

      <CreateOfferDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ["offers"] });
          setCreating(false);
        }}
      />
      <DeployDialog offer={deploying} onClose={() => setDeploying(null)} />
    </div>
  );
}

/** §6.2: "Create an offer with a name and the niche it targets." */
function CreateOfferDialog({
  open, onOpenChange, onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [campaignId, setCampaignId] = useState<number | null>(null);

  const campaigns = useQuery<{ items: Array<{ id: number; name: string; status: string }> }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: open,
    staleTime: 60_000,
  });

  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          niche: niche || null,
          sourceCampaignId: campaignId,
          campaignIds: campaignId ? [campaignId] : [],
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create the offer");
      return body;
    },
    onSuccess: () => {
      setName("");
      setNiche("");
      setCampaignId(null);
      onCreated();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New offer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Zillow Flex"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Niche</span>
            <Input
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="Real estate brokerages"
              className="mt-1 h-9 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium">Sequence from</span>
            <select
              value={campaignId ?? ""}
              onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Choose a campaign…</option>
              {(campaigns.data?.items ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {/* The offer IS a sequence, so it needs one to be worth anything. */}
            <span className="mt-1 block text-[11px] text-muted-foreground">
              This campaign&apos;s sequence becomes the offer&apos;s, and is what gets copied to
              other campaigns.
            </span>
          </label>

          {create.error ? (
            <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {create.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Create offer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One-click deploy.
 *
 * Reuses the §9.4 copy-sequence endpoint rather than a shortcut of its own, so
 * this inherits the whole safety story: the target's previous sequence is
 * snapshotted to the audit log before anything is written, Replace is refused
 * when a target step has already sent, and the "Re:" prefix is not
 * double-applied. "One click" describes the effort, not the number of checks.
 */
function DeployDialog({ offer, onClose }: { offer: OfferRow | null; onClose: () => void }) {
  const [targetId, setTargetId] = useState<number | null>(null);
  const [mode, setMode] = useState<"append" | "replace">("append");

  const campaigns = useQuery<{ items: Array<{ id: number; name: string; status: string }> }>({
    queryKey: ["campaigns", "all", ""],
    queryFn: async () => {
      const response = await fetch("/api/campaigns?status=all");
      if (!response.ok) throw new Error("Failed to load campaigns");
      return response.json();
    },
    enabled: Boolean(offer),
    staleTime: 60_000,
  });

  const deploy = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCampaignId: offer!.source!.source_campaign_id,
          mode,
          includeVariants: true,
          includeAttachments: true,
          apply: true,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.targetLeftEmpty
            ? `${body.error}\n\nThat campaign now has NO sequence. Its previous steps are in its Activity tab.`
            : (body.error ?? "The copy could not be applied"),
        );
      }
      return body;
    },
    onSuccess: onClose,
  });

  if (!offer) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy &ldquo;{offer.offer_name}&rdquo; to a campaign</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">
            {offer.source?.step_count} steps from{" "}
            <span className="text-foreground">{offer.source?.source_name}</span>
          </p>

          <label className="block">
            <span className="text-xs font-medium">Target campaign</span>
            <select
              value={targetId ?? ""}
              onChange={(e) => setTargetId(e.target.value ? Number(e.target.value) : null)}
              className="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm"
            >
              <option value="">Choose a campaign…</option>
              {(campaigns.data?.items ?? [])
                .filter((c) => c.id !== offer.source?.source_campaign_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.status}
                  </option>
                ))}
            </select>
          </label>

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

          {mode === "replace" ? (
            <p className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900">
              Replace deletes the target&apos;s current steps first. EmailBison refuses to delete
              a step that has already sent, so this fails on most live campaigns — its previous
              sequence is recorded in Activity before anything is removed either way.
            </p>
          ) : null}

          {deploy.error ? (
            <p className="whitespace-pre-line rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {deploy.error.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!targetId || deploy.isPending} onClick={() => deploy.mutate()}>
            {deploy.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            Copy sequence
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A discovered group, one name away from being an offer.
 *
 * The name field is pre-filled with the subject because that is very often the
 * offer's name already ("Join a Zillow preferred brokerage?" → Zillow Flex is a
 * rename, not a lookup), and an editable default beats an empty required field.
 */
function SuggestionCard({
  suggestion,
  onCreated,
}: {
  suggestion: Suggestion;
  onCreated: () => void;
}) {
  const [name, setName] = useState(suggestion.example_subject.replace(/\?$/, "").slice(0, 60));

  const create = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          sourceCampaignId: suggestion.source_campaign_id,
          campaignIds: suggestion.campaign_ids,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create the offer");
      return body;
    },
    onSuccess: onCreated,
  });

  return (
    <div className="rounded-xl border border-dashed bg-card/60 p-4">
      <p className="truncate text-sm font-medium" title={suggestion.example_subject}>
        {suggestion.example_subject}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {suggestion.campaigns} campaigns
        {suggestion.variants > 1 ? ` · ${suggestion.variants} subject variants` : ""}
        {suggestion.claimed > 0 ? ` · ${suggestion.claimed} already in an offer` : ""}
      </p>

      <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
        {(
          [
            ["Sent", compactNumber(suggestion.sent), ""],
            ["Reply", percent(suggestion.reply_rate, 1), ""],
            ["Positive", percent(suggestion.positive_rate, 1), "text-emerald-700"],
            ["Bounce", percent(suggestion.bounce_rate, 1), ""],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label}>
            <dd className={cn("tnum text-sm font-semibold", tone)}>{value}</dd>
            <dt className="text-[11px] text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>

      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name this offer"
        className="mt-3 h-8 text-xs"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!name.trim() || create.isPending}
        onClick={() => create.mutate()}
        className="mt-2 h-8 w-full text-xs"
      >
        {create.isPending ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
        Create offer from {suggestion.campaigns}{" "}
        {suggestion.campaigns === 1 ? "campaign" : "campaigns"}
      </Button>

      {create.error ? (
        <p className="mt-2 text-[11px] text-red-700">{create.error.message}</p>
      ) : null}
    </div>
  );
}

/**
 * Seeds subject-line tags so the dimension table has something to say on day
 * one. Only that dimension — see suggestSubjectLineType for why the other six
 * are left to humans.
 */
function SuggestTagsButton({ onDone }: { onDone: () => void }) {
  const run = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/copy/suggest", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not suggest tags");
      return body as { suggested: number };
    },
    onSuccess: onDone,
  });

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 gap-1.5 text-sm"
      disabled={run.isPending}
      onClick={() => run.mutate()}
      title="Reads each first email's subject and proposes its type. Marked as suggested until you confirm it."
    >
      {run.isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
      Suggest subject types
    </Button>
  );
}
