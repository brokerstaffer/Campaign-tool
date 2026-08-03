"use client";

import { useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAnalyticsFilters } from "@/components/analytics/filters-context";
import { CampaignPicker } from "@/components/analytics/campaign-picker";
import { SyncButton } from "@/components/analytics/sync-button";
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

interface Member {
  id: number;
  subject: string | null;
  campaign: string | null;
  sent: number;
  replies: number;
  positive: number;
  reply_rate: number | null;
  positive_rate: number | null;
  bounce_rate: number | null;
}

interface CopyRow {
  key: string;
  values: string[];
  members: Member[];
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
  const [editing, setEditing] = useState<OfferRow | null>(null);
  const [deploying, setDeploying] = useState<OfferRow | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

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
                  <button
                    type="button"
                    aria-label={`Edit ${offer.offer_name}`}
                    onClick={() => setEditing(offer)}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
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
              <div className="ml-auto flex items-center gap-2">
                <SyncButton />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreating(true)}
                  className="h-8 gap-1.5 text-sm"
                >
                  <Plus className="size-3.5" />
                  Add Group
                </Button>
              </div>
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
          <div className="mb-1">
            <h2 className="text-base font-semibold tracking-tight">How the copy performs</h2>
            {/*
              * "Question 2.68%" is meaningless without saying what is being
              * compared. This line names the unit (an opening email), the
              * grouping, and the fact that a row opens.
              */}
            <p className="text-sm text-muted-foreground">
              Every campaign&apos;s opening email, grouped by how its{" "}
              {dimensions.map((d) => dimensionLabel(d).toLowerCase()).join(" and ")} was written.
              Open a row to see the actual emails in it.
            </p>
          </div>

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
                  {dimensions.map((key, i) => (
                    <th key={key} className={cn("py-2.5 font-medium", i === 0 ? "pl-10 pr-4" : "px-4")}>
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
                  rows.flatMap((row) => {
                    const medal = medals.get(row);
                    const open = expanded === row.key;
                    return [
                      <tr
                        key={row.key}
                        onClick={() => setExpanded(open ? null : row.key)}
                        className="cursor-pointer transition-colors hover:bg-muted/50"
                      >
                        {row.values.map((value, i) => (
                          <td
                            key={i}
                            className={cn("truncate py-2.5", i === 0 ? "pl-3 pr-4" : "px-4")}
                            title={value}
                          >
                            {i === 0 ? (
                              <span className="mr-1.5 inline-block align-middle text-muted-foreground">
                                {open ? (
                                  <ChevronDown className="size-4" />
                                ) : (
                                  <ChevronRight className="size-4" />
                                )}
                              </span>
                            ) : null}
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
                      </tr>,

                      /*
                       * The emails behind the number. This is what makes the
                       * row mean something: "Direct wins" is only actionable
                       * once you can read the four subjects that are winning.
                       */
                      open ? (
                        <tr key={`${row.key}-open`} className="bg-muted/30">
                          <td colSpan={dimensions.length + 5} className="px-3 py-3">
                            <p className="mb-2 pl-7 text-xs text-muted-foreground">
                              {row.members.length} opening{" "}
                              {row.members.length === 1 ? "email" : "emails"} in this group
                            </p>
                            <table className="w-full table-fixed text-xs">
                              <thead>
                                <tr className="text-left text-muted-foreground">
                                  <th className="w-[42%] py-1 pl-7 pr-3 font-medium">Subject</th>
                                  <th className="w-[24%] px-3 py-1 font-medium">Campaign</th>
                                  <th className="px-3 py-1 text-right font-medium">Sent</th>
                                  <th className="px-3 py-1 text-right font-medium">Reply&nbsp;%</th>
                                  <th className="px-3 py-1 text-right font-medium">
                                    Positive&nbsp;%
                                  </th>
                                  <th className="px-3 py-1 text-right font-medium">
                                    Bounce&nbsp;%
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {row.members.map((m) => (
                                  <tr key={m.id}>
                                    <td
                                      className="truncate py-1 pl-7 pr-3"
                                      title={m.subject ?? ""}
                                    >
                                      {m.subject || (
                                        <em className="text-muted-foreground">No subject</em>
                                      )}
                                    </td>
                                    <td
                                      className="truncate px-3 py-1 text-muted-foreground"
                                      title={m.campaign ?? ""}
                                    >
                                      {m.campaign ?? "—"}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {fullNumber(m.sent)}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {percent(m.reply_rate, 2)}
                                    </td>
                                    <td className="tnum px-3 py-1 text-right">
                                      {percent(m.positive_rate, 2)}
                                    </td>
                                    <td
                                      className={cn(
                                        "tnum px-3 py-1 text-right",
                                        (m.bounce_rate ?? 0) >= 0.03 ? "text-[#b02525]" : "",
                                      )}
                                    >
                                      {percent(m.bounce_rate, 2)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      ) : null,
                    ];
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
          void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
          setCreating(false);
        }}
      />
      <EditOfferDialog
        offer={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          /*
           * BOTH caches. Deleting an offer frees its campaigns, which makes the
           * group they came from suggestable again — but the suggestions query
           * kept serving its old empty result, so the group simply vanished.
           * Every offer mutation changes what is suggestable.
           */
          void queryClient.invalidateQueries({ queryKey: ["offers"] });
          void queryClient.invalidateQueries({ queryKey: ["offer-suggestions"] });
          setEditing(null);
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
            <div className="mt-1">
              <CampaignPicker value={campaignId} onChange={setCampaignId} />
            </div>
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

  /*
   * Preview before apply, the same discipline as the §9.4 flow on the campaign
   * page. Copying a sequence into a live campaign changes what real prospects
   * receive, and "3 steps from X" is not something you can confirm against —
   * you need the subjects, the waits, and for Replace what would be destroyed.
   */
  const plan = useQuery({
    queryKey: ["copy-plan", offer?.offer_id, targetId, mode],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${targetId}/copy-sequence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceCampaignId: offer!.source!.source_campaign_id,
          mode,
          includeVariants: true,
          includeAttachments: true,
          apply: false,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not build the preview");
      return body.plan as {
        steps: Array<{
          order: number;
          subject: string | null;
          waitInDays: number | null;
          threadReply: boolean;
          isVariant: boolean;
          opening: string | null;
        }>;
        removing: Array<{ order: number; subject: string | null }>;
        blocked: boolean;
        warnings: string[];
      };
    },
    enabled: Boolean(offer?.source && targetId),
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

  const blocked = Boolean(plan.data?.blocked);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
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
            <div className="mt-1">
              <CampaignPicker
                value={targetId}
                onChange={(id) => {
                  setTargetId(id);
                  // A stale failure from the previous target or mode must not
                  // sit under the new one. That is what made an Append display
                  // a "cannot be deleted" error left over from a Replace.
                  deploy.reset();
                }}
                exclude={offer.source?.source_campaign_id ?? null}
              />
            </div>
          </label>

          <div className="flex gap-3 text-xs">
            {(["append", "replace"] as const).map((m) => (
              <label key={m} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  checked={mode === m}
                  onChange={() => {
                    setMode(m);
                    deploy.reset();
                  }}
                  className="accent-foreground"
                />
                <span className="capitalize">{m}</span>
              </label>
            ))}
          </div>

          {plan.isFetching ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Checking the target…
            </p>
          ) : null}

          {plan.data?.warnings.map((warning, i) => (
            <p
              key={i}
              className="rounded-md border border-amber-300/60 bg-amber-50 p-2 text-xs text-amber-900"
            >
              {warning}
            </p>
          ))}

          {plan.data?.removing.length ? (
            <div>
              <p className="mb-1 text-xs font-medium text-red-800">
                Will be deleted ({plan.data.removing.length})
              </p>
              <ul className="max-h-20 space-y-0.5 overflow-y-auto rounded-md border border-red-300/60 bg-red-50/50 p-2 text-xs">
                {plan.data.removing.map((step, i) => (
                  <li key={i} className="truncate line-through">
                    {step.order}. {step.subject || "(no subject)"}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.data?.steps.length ? (
            <div>
              <p className="mb-1 text-xs font-medium">Will be added ({plan.data.steps.length})</p>
              <ul className="max-h-52 space-y-1.5 overflow-y-auto rounded-md border p-2 text-xs">
                {plan.data.steps.map((step, i) => (
                  <li key={i}>
                    <span className="flex items-baseline gap-2">
                      <span className="tnum shrink-0 text-muted-foreground">{step.order}.</span>
                      <span className="min-w-0 flex-1 truncate">
                        {step.subject || "(no subject)"}
                      </span>
                      {step.threadReply ? (
                        <span className="shrink-0 rounded border px-1 text-[10px]">thread</span>
                      ) : null}
                      {step.isVariant ? (
                        <span className="shrink-0 rounded border px-1 text-[10px]">variant</span>
                      ) : null}
                      <span className="tnum shrink-0 text-muted-foreground">
                        {step.waitInDays ? `${step.waitInDays}d` : "immediate"}
                      </span>
                    </span>
                    {step.opening ? (
                      <span className="block truncate pl-6 text-[11px] text-muted-foreground">
                        {step.opening}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {plan.error ? (
            <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {(plan.error as Error).message}
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
          <Button
            size="sm"
            variant={plan.data?.removing.length ? "destructive" : "default"}
            disabled={!targetId || blocked || deploy.isPending || !plan.data?.steps.length}
            onClick={() => deploy.mutate()}
          >
            {deploy.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            {mode === "replace" && plan.data?.removing.length
              ? `Replace ${plan.data.removing.length} step${plan.data.removing.length === 1 ? "" : "s"}`
              : `Add ${plan.data?.steps.length ?? 0} step${plan.data?.steps.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

/**
 * Rename an offer, set its niche, and choose which campaign's sequence
 * represents it.
 *
 * Deleting is here too rather than on a separate screen, but it is deliberately
 * the least prominent control and it says what it does NOT do: removing the
 * label must never look like it might remove the campaigns.
 */
function EditOfferDialog({
  offer,
  onClose,
  onSaved,
}: {
  offer: OfferRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [niche, setNiche] = useState("");
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the draft from the offer when a different one is opened. Done during
  // render rather than in an effect — the React Compiler lint rejects setState
  // in an effect, and this is the same pattern range-picker.tsx uses.
  if (offer && loadedFor !== offer.offer_id) {
    setLoadedFor(offer.offer_id);
    setName(offer.offer_name);
    setNiche(offer.niche ?? "");
    setSourceId(offer.source?.source_campaign_id ?? null);
  }


  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/offers/${offer!.offer_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, niche: niche || null, sourceCampaignId: sourceId }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the offer");
      return body;
    },
    onSuccess: onSaved,
  });

  const remove = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/offers/${offer!.offer_id}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not delete the offer");
      return body;
    },
    onSuccess: onSaved,
  });

  if (!offer) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit offer</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
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
            <div className="mt-1">
              <CampaignPicker
                value={sourceId}
                onChange={setSourceId}
                emptyLabel="Highest-volume campaign (automatic)"
              />
            </div>
            <span className="mt-1 block text-[11px] text-muted-foreground">
              Campaigns in an offer drift apart as they are edited, so this picks which version
              gets copied. Left automatic, it follows the highest-volume one.
            </span>
          </label>

          {(save.error ?? remove.error) ? (
            <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
              {(save.error ?? remove.error)!.message}
            </p>
          ) : null}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Delete the offer "${offer.offer_name}"?\n\nIts ${offer.campaigns} campaigns are only detached — none of them is changed or deleted.`,
                )
              ) {
                remove.mutate();
              }
            }}
            className="text-red-700 hover:text-red-800"
          >
            Delete offer
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
