"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { EmailPanel } from "@/components/analytics/email-panel";
import { fullNumber } from "@/lib/analytics/format.ts";
import { cn } from "@/lib/utils";

/*
 * The sequence, read-only: steps in order, variants nested under the step they
 * replace, each one openable to its actual email.
 *
 * EXTRACTED SO THERE IS ONE OF THESE, not two. The campaign page had this
 * inline, so when Copy & Offer needed to show a sequence the choice was to
 * duplicate it — and a second copy is exactly how "3 steps and 1 variant"
 * becomes "4 steps" again on one screen and not the other. Every rule about
 * what a step is, what a variant is, and where the wait belongs now lives here
 * and is inherited by every caller.
 */

export interface StepStats {
  sent: number;
  contacted: number;
  opens: number;
  replies: number;
  bounced: number;
  unsubscribed: number;
  interested: number;
}

export interface SequenceStep {
  id: number;
  step_order: number | null;
  email_subject: string | null;
  email_body: string | null;
  wait_in_days: number | null;
  is_variant: boolean;
  thread_reply: boolean;
  orphanedVariant?: boolean;
  stats: StepStats | null;
  variants: Array<Omit<SequenceStep, "variants">>;
}

/**
 * The two counts, from one definition.
 *
 * A variant occupies its parent's position rather than adding one, so it is
 * never a step. Callers that print "N steps" read `steps` from here instead of
 * measuring an array that may or may not have variants flattened into it.
 */
export function countSequence(steps: SequenceStep[]): { steps: number; variants: number } {
  return {
    steps: steps.length,
    variants: steps.reduce((n, s) => n + s.variants.length, 0),
  };
}

/** "3 steps · 1 variant", or just "3 steps" when there are none. */
export function describeSequence(steps: SequenceStep[]): string {
  const { steps: n, variants } = countSequence(steps);
  const stepPart = `${n} step${n === 1 ? "" : "s"}`;
  if (!variants) return stepPart;
  return `${stepPart} · ${variants} variant${variants === 1 ? "" : "s"}`;
}

export function StepStatsRow({ stats }: { stats: StepStats | null }) {
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

/** One variant of a step: its letter, its subject, its numbers, its email. */
function VariantRow({
  variant,
  index,
}: {
  variant: Omit<SequenceStep, "variants">;
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
            {variant.email_subject || <em className="text-muted-foreground">No subject</em>}
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

export function SequenceView({ steps }: { steps: SequenceStep[] }) {
  const [open, setOpen] = useState<number | null>(steps[0]?.id ?? null);

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div key={step.id} className="rounded-xl border bg-card shadow-sm">
          <button
            type="button"
            onClick={() => setOpen(open === step.id ? null : step.id)}
            className="flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 p-3 text-left hover:bg-accent/40"
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
            {/* Wraps to its own line on a narrow screen rather than being
                hidden — the wait and the variant count are the two things
                that make the row readable as a sequence. */}
            <span className="flex w-full shrink-0 flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted-foreground sm:w-auto">
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
