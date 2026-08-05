"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pause,
  Play,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmailPanel } from "@/components/analytics/email-panel";
import { CopySequenceDialog } from "@/components/campaigns/copy-sequence-dialog";
import { PushSequenceDialog } from "@/components/campaigns/push-sequence-dialog";
import { BulkDeployPanel, useBulkDeploy } from "@/components/analytics/bulk-deploy";
import { SequenceEditor, type EditableStep } from "@/components/campaigns/sequence-editor";
import { CopyTagsPanel } from "@/components/campaigns/copy-tags-panel";
import { OfferPicker } from "@/components/campaigns/offer-picker";
import { fullNumber, percent } from "@/lib/analytics/format.ts";
import { STATUS_TONE, canApply, isKnownStatus } from "@/lib/campaigns/status.ts";
import { cn } from "@/lib/utils";

/*
 * Campaign detail (spec §9.2).
 *
 * The header carries the essentials — daily limit, variant count, created date —
 * with one primary button that is Pause or Resume depending on status, and is
 * absent entirely when neither applies. A greyed-out primary button on a
 * completed campaign invites the click that queues 828 people to receive email.
 */

interface Step {
  id: number;
  step_order: number | null;
  email_subject: string | null;
  email_body: string | null;
  wait_in_days: number | null;
  is_variant: boolean;
  thread_reply: boolean;
  orphanedVariant?: boolean;
  stats: StepStats | null;
  variants: Array<Omit<Step, "variants">>;
}

interface StepStats {
  sent: number;
  contacted: number;
  opens: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
}

interface Campaign {
  id: number;
  name: string;
  status: string;
  tags: unknown[];
  total_leads: number | null;
  total_leads_contacted: number | null;
  lifetime_emails_sent: number | null;
  lifetime_opened: number | null;
  lifetime_unique_opens: number | null;
  lifetime_replied: number | null;
  lifetime_unique_replies: number | null;
  lifetime_bounced: number | null;
  lifetime_unsubscribed: number | null;
  lifetime_interested: number | null;
  completion_percentage: number | null;
  max_emails_per_day: number | null;
  max_new_leads_per_day: number | null;
  plain_text: boolean | null;
  open_tracking: boolean | null;
  can_unsubscribe: boolean | null;
  unsubscribe_text: string | null;
  include_auto_replies_in_stats: boolean | null;
  sequence_prioritization: string | null;
  eb_created_at: string | null;
  sequence_id: number | null;
  excluded: boolean;
  excludeReason: string | null;
}

interface Activity {
  id: number;
  action: string;
  actor: string;
  status: string;
  error: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  created_at: string;
}

interface DetailResponse {
  campaign: Campaign;
  sequence: Step[];
  variantCount: number;
  activity: Activity[];
  sentStepIds: number[];
}

/*
 * WT §9.2 lists five tabs. "Copy & Offer" — the dimension tags for each email
 * and which offer this campaign sells — existed only nested inside Sequence,
 * where you had to expand a step to reach it. Its own tab, per the spec.
 */
const TABS = ["Overview", "Sequence", "Copy & Offer", "Settings", "Activity"] as const;
type Tab = (typeof TABS)[number];

export function CampaignDetail({ id }: { id: number }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("Overview");

  const { data, isLoading, error } = useQuery<DetailResponse>({
    queryKey: ["campaign", id],
    queryFn: async () => {
      const response = await fetch(`/api/campaigns/${id}`);
      if (!response.ok) {
        throw new Error((await response.json()).error ?? "Failed to load campaign");
      }
      return response.json();
    },
    staleTime: 30_000,
  });

  const act = useMutation({
    mutationFn: async (action: "pause" | "resume") => {
      const response = await fetch("/api/campaigns/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, campaignIds: [id], confirm: true }),
      });
      const body = await response.json();
      if (!response.ok && response.status !== 207) {
        throw new Error(body.error ?? "The action could not be applied");
      }
      const result = body.results?.[0];
      if (result && !result.ok) throw new Error(result.error);
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", id] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">
          {error instanceof Error ? error.message : "Campaign not found"}
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </div>
    );
  }

  const { campaign, sequence, variantCount, activity, sentStepIds } = data;

  // Shown only when it can actually be applied. Neither → no primary button.
  const primary = canApply("pause", campaign.status)
    ? ("pause" as const)
    : canApply("resume", campaign.status)
      ? ("resume" as const)
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/30">
      <header className="shrink-0 border-b bg-card px-8 py-4">
        <Link
          href="/campaigns"
          className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3" />
          Campaigns
        </Link>

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-medium" title={campaign.name}>
              {campaign.name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <StatusChip status={campaign.status} />
              <span className="tnum">
                {fullNumber(campaign.max_emails_per_day)}/day
              </span>
              <span>·</span>
              <span className="tnum">
                {variantCount} {variantCount === 1 ? "variant" : "variants"}
              </span>
              <span>·</span>
              <span>
                Created{" "}
                {campaign.eb_created_at
                  ? new Date(campaign.eb_created_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })
                  : "—"}
              </span>
              {campaign.excluded ? (
                <>
                  <span>·</span>
                  <span className="italic">excluded — {campaign.excludeReason}</span>
                </>
              ) : null}
            </p>
          </div>

          {primary ? (
            <Button
              size="sm"
              variant={primary === "resume" ? "default" : "outline"}
              disabled={act.isPending}
              onClick={() => {
                if (
                  primary === "resume" &&
                  !window.confirm(
                    `Resume "${campaign.name}"?\n\nThis queues the campaign to send. ` +
                      `${fullNumber(campaign.total_leads)} leads are attached and may begin ` +
                      `receiving email. It does not restore a previous status.`,
                  )
                ) {
                  return;
                }
                act.mutate(primary);
              }}
              className="gap-1.5"
            >
              {act.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : primary === "pause" ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {primary === "pause" ? "Pause" : "Resume"}
            </Button>
          ) : null}
        </div>

        {act.error ? (
          <p className="mt-2 rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
            {act.error.message}
          </p>
        ) : null}
      </header>

      <div className="flex shrink-0 gap-0.5 border-b bg-card px-8">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-xs transition-colors",
              tab === t
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
            {t === "Activity" && activity.length ? (
              <span className="tnum ml-1.5 text-muted-foreground">{activity.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        {tab === "Overview" ? <Overview campaign={campaign} /> : null}
        {tab === "Sequence" ? (
          <Sequence
            steps={sequence}
            campaignId={campaign.id}
            campaignName={campaign.name}
            sequenceId={campaign.sequence_id ?? null}
            sentStepIds={sentStepIds ?? []}
          />
        ) : null}
        {tab === "Copy & Offer" ? (
          <CopyAndOffer campaignId={campaign.id} steps={sequence} />
        ) : null}
        {tab === "Settings" ? <Settings campaign={campaign} /> : null}
        {tab === "Activity" ? <ActivityLog rows={activity} /> : null}
      </div>
    </div>
  );
}

/**
 * Copy & Offer for one campaign (WT §9.2).
 *
 * Two things on one screen because they answer the same question — "what is
 * this campaign actually selling, and how is it worded?"
 *
 * Only the FIRST email is taggable, matching the analysis: later steps inherit
 * the opener's framing, so tagging them separately would create dimensions that
 * cannot be compared. Follow-ups are listed but read-only, so the sequence is
 * still visible without implying they carry their own copy identity.
 */
function CopyAndOffer({ campaignId, steps }: { campaignId: number; steps: Step[] }) {
  const ordered = [...steps].sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  const first = ordered[0] ?? null;
  const followUps = ordered.slice(1);

  if (!first) {
    return (
      <p className="py-16 text-center text-sm text-muted-foreground">
        This campaign has no sequence yet, so there is no copy to tag.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Offer</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Which offer this campaign sells. Offers are tracked in their own right on
            the Copy &amp; Offer tab, not just as campaign names.
          </p>
        </div>
        <div className="px-5 py-4">
          <OfferPicker campaignId={campaignId} />
        </div>
      </section>

      <section className="rounded-xl border bg-card">
        <div className="border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Copy dimensions</h2>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {first.email_subject || "(no subject)"}
          </p>
        </div>
        <div className="px-5 py-4">
          <CopyTagsPanel stepId={first.id} isFirstEmail />
        </div>
      </section>

      {followUps.length ? (
        <section className="rounded-xl border bg-card">
          <div className="border-b px-5 py-3">
            <h2 className="text-sm font-semibold">Follow-ups</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Not tagged. Copy analysis covers the opening email only — a follow-up
              inherits its framing, so tagging it separately would compare a
              dimension against itself.
            </p>
          </div>
          <ul className="divide-y">
            {followUps.map((step, i) => (
              <li key={step.id} className="flex items-baseline gap-3 px-5 py-2.5 text-sm">
                <span className="tnum shrink-0 text-xs text-muted-foreground">
                  Step {i + 2}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {step.email_subject || "(no subject)"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** One variant of a step: subject, its numbers, and its actual email. */
function VariantRow({
  variant,
  index,
}: {
  variant: Omit<Step, "variants">;
  index: number;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="tnum shrink-0 rounded bg-background px-1.5 text-[11px]">
          {String.fromCharCode(65 + index)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs">
            {variant.email_subject || (
              <em className="text-muted-foreground">No subject</em>
            )}
          </span>
          <span className="mt-1 block">
            <StepStatsRow stats={variant.stats} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-t bg-background p-2.5">
          <EmailPanel subject={variant.email_subject} body={variant.email_body} />
        </div>
      ) : null}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const tone = isKnownStatus(status) ? STATUS_TONE[status] : "bg-red-100 text-red-800";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", tone)}>
      {status}
    </span>
  );
}

function Overview({ campaign }: { campaign: Campaign }) {
  const sent = campaign.lifetime_emails_sent ?? 0;

  /*
   * A funnel, not a bar chart: each stage is a share of the one above it, so
   * the bars are drawn relative to `sent` rather than to each other. Drawing
   * them relative to the largest value would make a 1% reply rate look like a
   * full bar whenever nothing else happened.
   */
  const funnel = [
    { label: "Sent", value: sent, tone: "bg-[#2a78d6]" },
    { label: "Replied", value: campaign.lifetime_unique_replies ?? 0, tone: "bg-[#eb6834]" },
    { label: "Interested", value: campaign.lifetime_interested ?? 0, tone: "bg-[#008300]" },
    { label: "Bounced", value: campaign.lifetime_bounced ?? 0, tone: "bg-[#e34948]" },
  ];

  const stats = [
    ["Leads", campaign.total_leads],
    ["Leads contacted", campaign.total_leads_contacted],
    ["Emails sent", campaign.lifetime_emails_sent],
    ["Opens", campaign.lifetime_opened],
    ["Unique opens", campaign.lifetime_unique_opens],
    ["Replies", campaign.lifetime_replied],
    ["Unique replies", campaign.lifetime_unique_replies],
    ["Interested", campaign.lifetime_interested],
    ["Bounced", campaign.lifetime_bounced],
    ["Unsubscribed", campaign.lifetime_unsubscribed],
  ] as const;

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[1.3fr_1fr]">
      <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="mb-1.5 flex items-baseline justify-between">
          <h2 className="text-sm font-medium">
            Progress
          </h2>
          <span className="tnum text-xs text-muted-foreground">
            {campaign.completion_percentage != null
              ? percent(campaign.completion_percentage / 100)
              : "—"}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-foreground/70 transition-[width]"
            style={{ width: `${Math.min(campaign.completion_percentage ?? 0, 100)}%` }}
          />
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="mb-3 text-sm font-medium">
          Funnel <span className="font-normal text-muted-foreground">(lifetime)</span>
        </h2>
        <div className="space-y-1.5">
          {funnel.map((stage) => (
            <div key={stage.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">{stage.label}</span>
              <div className="h-4 min-w-0 flex-1 overflow-hidden rounded bg-muted">
                <div
                  className={cn("h-full rounded", stage.tone)}
                  style={{ width: sent ? `${(stage.value / sent) * 100}%` : "0%" }}
                />
              </div>
              <span className="tnum w-20 shrink-0 text-right text-xs">
                {fullNumber(stage.value)}
              </span>
              <span className="tnum w-14 shrink-0 text-right text-xs text-muted-foreground">
                {sent ? percent(stage.value / sent, 2) : "-"}
              </span>
            </div>
          ))}
        </div>
        {/* These are cumulative counters from EmailBison, not the day-based
            figures the Analytics tab computes. Saying so stops the two being
            read as a discrepancy. */}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Lifetime totals as EmailBison reports them. For a date range, use Analytics.
        </p>
      </section>

      </div>

      <div className="space-y-5">
      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="mb-2 text-sm font-medium">
          Detail
        </h2>
        <dl className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          {stats.map(([label, value]) => (
            <div key={label} className="flex justify-between border-b py-1.5 text-xs">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tnum">{fullNumber(value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {Array.isArray(campaign.tags) && campaign.tags.length ? (
        <section className="rounded-xl border bg-card p-5 shadow-sm">
          <h2 className="mb-2 text-sm font-medium">
            Tags
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {campaign.tags.map((tag, i) => {
              const label =
                typeof tag === "string"
                  ? tag
                  : ((tag as { name?: string })?.name ?? JSON.stringify(tag));
              return (
                <span key={i} className="rounded border bg-card px-2 py-0.5 text-xs">
                  {label}
                </span>
              );
            })}
          </div>
        </section>
      ) : null}
      </div>
    </div>
  );
}

function StepStatsRow({ stats }: { stats: StepStats | null }) {
  if (!stats) {
    // No day-stat rows for this step. Not the same as zero sends — the
    // day-stats backfill only reaches so far back.
    return <span className="text-[11px] text-muted-foreground">no stats in range</span>;
  }
  const cells: Array<[string, number]> = [
    ["sent", stats.sent],
    ["opens", stats.opens],
    ["replies", stats.replies],
    ["interested", stats.interested],
    ["bounced", stats.bounced],
  ];
  return (
    <span className="tnum flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
      {cells.map(([label, value]) => (
        <span key={label}>
          {fullNumber(value)} {label}
        </span>
      ))}
    </span>
  );
}

function Sequence({
  steps,
  campaignId,
  campaignName,
  sequenceId,
  sentStepIds,
}: {
  steps: Step[];
  campaignId: number;
  campaignName: string;
  sequenceId: number | null;
  sentStepIds: number[];
}) {
  const [open, setOpen] = useState<number | null>(steps[0]?.id ?? null);
  const [copying, setCopying] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [editing, setEditing] = useState(false);
  const deploy = useBulkDeploy();

  /*
   * Variants are flattened back out for editing. The read view nests them under
   * their parent, but EmailBison's sequence is a flat ordered list and saving a
   * nested shape would have to invent an ordering for the variants.
   */
  const editable: EditableStep[] = steps
    .flatMap((step) => [step, ...step.variants])
    .map((step) => ({
      key: `s${step.id}`,
      id: step.id,
      email_subject: step.email_subject ?? "",
      email_body: step.email_body ?? "",
      wait_in_days: step.wait_in_days ?? 0,
      thread_reply: Boolean(step.thread_reply),
      variant: Boolean(step.is_variant),
    }));

  if (editing) {
    return (
      <SequenceEditor
        campaignId={campaignId}
        sequenceId={sequenceId}
        initial={editable}
        sentStepIds={sentStepIds}
        onDone={() => setEditing(false)}
      />
    );
  }

  const copyButton = (
    <>
      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setEditing(true)}>
        Edit sequence
      </Button>
      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCopying(true)}>
        Copy sequence from…
      </Button>
      {/* The other direction. This campaign's sequence is often the proven one,
          and rolling it out was previously only possible from an offer card —
          which meant creating an offer just to reuse a sequence. */}
      <Button
        size="sm"
        className="h-8 text-xs"
        disabled={!steps.length}
        onClick={() => setPushing(true)}
      >
        Push to campaigns…
      </Button>
      <CopySequenceDialog
        targetId={campaignId}
        targetName={campaignName}
        open={copying}
        onOpenChange={setCopying}
      />
      <PushSequenceDialog
        sourceId={campaignId}
        sourceName={campaignName}
        // Steps only. A variant is an alternative wording at an existing
        // position, so counting it here overstates what gets pushed.
        stepCount={steps.filter((s) => !s.is_variant).length}
        open={pushing}
        onOpenChange={setPushing}
        onStart={deploy.start}
      />
    </>
  );

  if (!steps.length) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 rounded-xl border bg-card p-5 shadow-sm">
        <p className="text-sm text-muted-foreground">
          This campaign has no sequence steps cached. Run sync-steps if it has one upstream, or
          copy a sequence from another campaign.
        </p>
        <div className="flex gap-2">{copyButton}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <BulkDeployPanel
        batch={deploy.batch}
        running={deploy.running}
        onRetry={deploy.retryFailed}
        onDismiss={deploy.dismiss}
      />
      <div className="flex flex-wrap justify-end gap-2">{copyButton}</div>
      {steps.map((step, index) => (
        <div key={step.id} className="rounded-xl border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setOpen(open === step.id ? null : step.id)}
            className="flex w-full items-start gap-3 p-3 text-left hover:bg-accent/40"
          >
            {open === step.id ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="tnum mt-0.5 shrink-0 rounded bg-muted px-1.5 text-xs">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                {step.email_subject || <em className="text-muted-foreground">No subject</em>}
              </span>
              <span className="mt-1 block">
                <StepStatsRow stats={step.stats} />
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              {step.orphanedVariant ? (
                <span
                  className="flex items-center gap-1 text-amber-700"
                  title="This variant's parent step no longer exists upstream. Shown here so its volume isn't lost."
                >
                  <AlertTriangle className="size-3" />
                  orphaned
                </span>
              ) : null}
              {step.thread_reply ? <span className="rounded border px-1">thread</span> : null}
              {/*
                Shown as the gap BEFORE this step, which is the previous step's
                wait_in_days — EmailBison defines the field as "how many days
                before the sequence moves to the next step". Step 1 has no gap:
                it sends when the lead enters, and printing its own wait here
                claimed a delay that never happens.
              */}
              <span className="tnum">
                {index === 0
                  ? "sends immediately"
                  : steps[index - 1]?.wait_in_days
                    ? `${steps[index - 1].wait_in_days}d after step ${index}`
                    : "immediately after"}
              </span>
              {step.variants.length ? (
                <span className="tnum rounded border px-1">
                  {step.variants.length} variant{step.variants.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          </button>

          {open === step.id ? (
            <div className="space-y-3 border-t p-3">
              <EmailPanel subject={step.email_subject} body={step.email_body} />

              {step.variants.length ? (
                <div className="space-y-2">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    Variants
                  </p>
                  {/*
                    Openable, like a step. A variant showed its subject and its
                    numbers with no way to read the email — which is the one
                    thing you need in order to judge why it is winning or
                    losing against the step it replaces.
                  */}
                  {step.variants.map((variant, vi) => (
                    <VariantRow key={variant.id} variant={variant} index={vi} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/*
 * Grouped into sections rather than one long column of unrelated fields.
 * Naming, sending limits and content behaviour are three different decisions,
 * and stacking them flat made the panel read as a settings dump with no
 * hierarchy. Centred to match every other tab — left-aligned at max-w-2xl it
 * left most of a wide screen empty.
 */
function Settings({ campaign }: { campaign: Campaign }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: campaign.name,
    max_emails_per_day: campaign.max_emails_per_day ?? 0,
    max_new_leads_per_day: campaign.max_new_leads_per_day ?? 0,
    plain_text: campaign.plain_text ?? false,
    open_tracking: campaign.open_tracking ?? false,
    can_unsubscribe: campaign.can_unsubscribe ?? false,
    include_auto_replies_in_stats: campaign.include_auto_replies_in_stats ?? false,
  });

  const save = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/campaigns/${campaign.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save settings");
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", campaign.id] });
      void queryClient.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  // §9.3: "Changes are saved only when you press Save."
  const dirty =
    form.name !== campaign.name ||
    form.max_emails_per_day !== (campaign.max_emails_per_day ?? 0) ||
    form.max_new_leads_per_day !== (campaign.max_new_leads_per_day ?? 0) ||
    form.plain_text !== (campaign.plain_text ?? false) ||
    form.open_tracking !== (campaign.open_tracking ?? false) ||
    form.can_unsubscribe !== (campaign.can_unsubscribe ?? false) ||
    form.include_auto_replies_in_stats !== (campaign.include_auto_replies_in_stats ?? false);

  const toggles = [
    ["open_tracking", "Open tracking", "Adds a tracking pixel to every email."],
    ["plain_text", "Plain text", "Sends without HTML formatting."],
    ["can_unsubscribe", "One-click unsubscribe", "Adds an unsubscribe link."],
    [
      "include_auto_replies_in_stats",
      "Count auto-replies in stats",
      "Out-of-office replies counted as replies.",
    ],
  ] as const;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <section className="space-y-1.5 rounded-xl border bg-card p-5 shadow-sm">
        <label htmlFor="name" className="text-xs font-medium">
          Campaign name
        </label>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="h-8 text-sm"
        />
        {/* Renaming moves the campaign between clients, because attribution is
            matched on the name. Worth saying before it happens, not after. */}
        <p className="text-[11px] text-muted-foreground">
          The client is derived from this name — renaming can reassign the campaign.
        </p>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-semibold">Sending limits</h3>
        <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="limit" className="text-xs font-medium">
            Daily send limit
          </label>
          <Input
            id="limit"
            type="number"
            min={0}
            value={form.max_emails_per_day}
            onChange={(e) => setForm({ ...form, max_emails_per_day: Number(e.target.value) })}
            className="tnum h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="leads" className="text-xs font-medium">
            New leads per day
          </label>
          <Input
            id="leads"
            type="number"
            min={0}
            value={form.max_new_leads_per_day}
            onChange={(e) => setForm({ ...form, max_new_leads_per_day: Number(e.target.value) })}
            className="tnum h-8 text-sm"
          />
        </div>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h3 className="mb-3 text-xs font-semibold">Content and tracking</h3>
        <div className="space-y-2.5">
        {toggles.map(([key, label, hint]) => (
          <label key={key} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
              className="mt-0.5 size-3.5 accent-foreground"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium">{label}</span>
              <span className="block text-[11px] text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
        </div>

        {campaign.can_unsubscribe && campaign.unsubscribe_text ? (
          <div className="mt-4 space-y-1.5 border-t pt-4">
            <p className="text-xs font-medium">Unsubscribe wording</p>
            <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
              {campaign.unsubscribe_text}
            </p>
          </div>
        ) : null}
      </section>

      {/* Sticky, so Save is reachable without scrolling back up once the
          sections grow. */}
      <div className="sticky bottom-0 flex items-center gap-3 rounded-xl border bg-card px-5 py-3 shadow-sm">
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          Save changes
        </Button>
        {dirty ? (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        ) : save.isSuccess ? (
          <span className="text-xs text-emerald-700">Saved to EmailBison</span>
        ) : null}

        {save.error ? (
          <p className="ml-auto max-w-md rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-800">
            {/* §9.5: the platform's actual reason, and the form still shows the
                edit as unsaved. */}
            {save.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** §9.2 Activity: "what changed, and what it was before". */
function ActivityLog({ rows }: { rows: Activity[] }) {
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No changes recorded yet. Every pause, resume, archive and settings edit made here
        appears in this list.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-2">
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "rounded-xl border bg-card p-3 text-xs shadow-sm",
            row.status === "error" && "border-red-300/60 bg-red-50/50",
          )}
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium capitalize">{row.action}</span>
            {row.status === "error" ? (
              <span className="rounded bg-red-100 px-1.5 text-[11px] text-red-800">failed</span>
            ) : null}
            <span className="text-muted-foreground">{row.actor}</span>
            <span className="ml-auto text-muted-foreground">
              {new Date(row.created_at).toLocaleString()}
            </span>
          </div>

          {row.error ? <p className="mt-1.5 text-red-800">{row.error}</p> : null}

          {row.before_state ? (
            <dl className="mt-1.5 space-y-0.5 text-[11px]">
              {Object.entries(row.before_state).map(([key, before]) => {
                const after = row.after_state?.[key];
                if (after === undefined) return null;
                return (
                  <div key={key} className="flex gap-2">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="flex gap-1.5">
                      <span className="text-muted-foreground line-through">
                        {String(before)}
                      </span>
                      <span>→</span>
                      <span className="font-medium">{String(after)}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
        </div>
      ))}
    </div>
  );
}
