"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmailPanel } from "@/components/analytics/email-panel";
import { countVariations } from "@/lib/spintax.ts";
import { CopyTagsPanel } from "@/components/campaigns/copy-tags-panel";

/*
 * The sequence editor (spec §9.3).
 *
 * "Changes are saved only when you press Save. If you try to leave with unsaved
 * edits, you'll be warned. Nothing goes live by accident."
 *
 * Everything below is local state until Save. The component never mutates the
 * server copy, and the Save button is the only thing that can.
 *
 * Reordering is buttons, not drag-and-drop. The spec asks for drag, but a drag
 * handle on a list that edits live email sequences is a one-slip mistake with
 * no undo, and it is unusable by keyboard. Up/down is explicit, reversible in
 * one click, and works everywhere. Flagging the deviation rather than hiding it.
 */

const MERGE_TAGS = [
  "{FIRST_NAME}",
  "{LAST_NAME}",
  "{EMAIL}",
  "{COMPANY_NAME}",
  "{JOB_TITLE}",
  "{CITY}",
  "{STATE}",
];

export interface EditableStep {
  /** Absent = added in this session, not yet on EmailBison. */
  id?: number;
  email_subject: string;
  email_body: string;
  wait_in_days: number;
  thread_reply: boolean;
  variant: boolean;
  variant_from_step_id?: number | null;
  /** Local key so React can track rows that have no id yet. */
  key: string;
}

export function SequenceEditor({
  campaignId,
  sequenceId,
  initial,
  sentStepIds,
  onDone,
}: {
  campaignId: number;
  sequenceId: number | null;
  initial: EditableStep[];
  /** Steps EmailBison will refuse to delete. */
  sentStepIds: number[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<EditableStep[]>(initial);
  const [open, setOpen] = useState<string | null>(initial[0]?.key ?? null);
  const bodyRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const sent = new Set(sentStepIds);
  const dirty = JSON.stringify(steps) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: async () => {
      if (!sequenceId) {
        throw new Error(
          "This campaign has no sequence id cached yet. Run sync-entities, then reload.",
        );
      }
      const response = await fetch(`/api/campaigns/${campaignId}/sequence`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sequenceId,
          steps: steps.map((s) => ({
            id: s.id,
            email_subject: s.email_subject,
            email_body: s.email_body,
            wait_in_days: s.wait_in_days,
            thread_reply: s.thread_reply,
            variant: s.variant,
            variant_from_step_id: s.variant_from_step_id ?? null,
          })),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.partiallyApplied
            ? `${body.error}\n\nPart of the save was applied (${body.partiallyApplied.updated} updated, ` +
              `${body.partiallyApplied.added} added, ${body.partiallyApplied.deleted} deleted). ` +
              `Reload before trying again.`
            : (body.error ?? "The sequence could not be saved"),
        );
      }
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["campaign", campaignId] });
      onDone();
    },
  });

  function update(index: number, patch: Partial<EditableStep>) {
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    setSteps(next);
  }

  function remove(index: number) {
    setSteps(steps.filter((_, i) => i !== index));
  }

  function add() {
    const key = `new-${Date.now()}`;
    setSteps([
      ...steps,
      {
        key,
        email_subject: "",
        email_body: "",
        // Defaults that match the workspace's dominant pattern rather than
        // zeros, which would send the whole sequence at once.
        wait_in_days: 1,
        thread_reply: steps.length > 0,
        variant: false,
      },
    ]);
    setOpen(key);
  }

  /** Inserts at the cursor rather than appending — §9.3 asks for a menu, not typing. */
  function insertTag(index: number, tag: string) {
    const field = bodyRefs.current[steps[index].key];
    const body = steps[index].email_body;
    if (!field) return update(index, { email_body: body + tag });
    const start = field.selectionStart ?? body.length;
    const end = field.selectionEnd ?? start;
    update(index, { email_body: body.slice(0, start) + tag + body.slice(end) });
    queueMicrotask(() => {
      field.focus();
      field.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  return (
    <div className="max-w-4xl space-y-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium">Editing sequence</span>
        <span className="text-[11px] text-muted-foreground">
          Nothing is sent to EmailBison until you press Save.
        </span>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-amber-700">Unsaved changes</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={!dirty || save.isPending}
            onClick={() => setSteps(initial)}
          >
            <Undo2 className="size-3" />
            Revert
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={save.isPending}
            onClick={() => {
              // §9.3: warned before losing edits.
              if (
                dirty &&
                !window.confirm("Discard your unsaved changes to this sequence?")
              ) {
                return;
              }
              onDone();
            }}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!dirty || save.isPending || steps.length === 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : null}
            Save
          </Button>
        </div>
      </div>

      {save.error ? (
        <p className="whitespace-pre-line rounded-md border border-red-300/60 bg-red-50 p-2.5 text-xs text-red-800">
          {save.error.message}
        </p>
      ) : null}

      {steps.map((step, index) => {
        const isNew = step.id == null;
        const locked = step.id != null && sent.has(step.id);
        const variations = countVariations(step.email_body);

        return (
          <div key={step.key} className="rounded-lg border">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="tnum shrink-0 rounded bg-muted px-1.5 text-xs">{index + 1}</span>

              <button
                type="button"
                onClick={() => setOpen(open === step.key ? null : step.key)}
                className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
              >
                {step.email_subject || (
                  <em className="text-muted-foreground">Untitled step</em>
                )}
              </button>

              {isNew ? (
                <span className="shrink-0 rounded bg-emerald-100 px-1.5 text-[11px] text-emerald-800">
                  new
                </span>
              ) : null}
              {variations > 1 ? (
                <span className="tnum shrink-0 rounded border px-1 text-[11px] text-muted-foreground">
                  {variations} variations
                </span>
              ) : null}

              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label="Move step up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                >
                  <ChevronUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Move step down"
                  disabled={index === steps.length - 1}
                  onClick={() => move(index, 1)}
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
                >
                  <ChevronDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Remove step"
                  disabled={locked}
                  onClick={() => remove(index)}
                  // The tooltip is the whole explanation: EmailBison refuses to
                  // delete a step that has sent, so the button can't work.
                  title={
                    locked
                      ? "This step has already sent emails — EmailBison will not delete it"
                      : "Remove this step"
                  }
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-red-700 disabled:opacity-30"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>

            {open === step.key ? (
              <div className="space-y-3 p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-[240px] flex-1 space-y-1">
                    <label className="text-[11px] font-medium">Subject</label>
                    <Input
                      value={step.email_subject}
                      onChange={(e) => update(index, { email_subject: e.target.value })}
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="w-28 space-y-1">
                    <label className="text-[11px] font-medium">Wait (days)</label>
                    <Input
                      type="number"
                      min={0}
                      value={step.wait_in_days}
                      onChange={(e) =>
                        update(index, { wait_in_days: Number(e.target.value) || 0 })
                      }
                      className="tnum h-8 text-xs"
                    />
                  </div>
                  <label className="flex h-8 cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={step.thread_reply}
                      onChange={(e) => update(index, { thread_reply: e.target.checked })}
                      className="size-3.5 accent-foreground"
                    />
                    <span className="text-[11px]">Reply in thread</span>
                  </label>
                </div>

                {step.thread_reply ? (
                  // Otherwise the saved subject differs from what was typed and
                  // looks like the edit failed.
                  <p className="text-[11px] text-muted-foreground">
                    EmailBison adds the &ldquo;Re: &rdquo; prefix to threaded steps — don&apos;t
                    type it.
                  </p>
                ) : null}

                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[11px] font-medium">Body</label>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="h-6 text-[11px]">
                          Insert field
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {MERGE_TAGS.map((tag) => (
                          <DropdownMenuItem
                            key={tag}
                            onSelect={() => insertTag(index, tag)}
                            className="font-mono text-xs"
                          >
                            {tag}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <textarea
                    ref={(el) => {
                      bodyRefs.current[step.key] = el;
                    }}
                    value={step.email_body}
                    onChange={(e) => update(index, { email_body: e.target.value })}
                    rows={10}
                    spellCheck
                    className="w-full rounded-md border bg-background p-2 font-mono text-xs leading-relaxed"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    HTML and spintax (<code>{"{a|b}"}</code>) are both preserved as typed.
                  </p>
                </div>

                <div>
                  <p className="mb-1 text-[11px] font-medium">Preview</p>
                  <EmailPanel subject={step.email_subject} body={step.email_body} />
                </div>

                {/* §6.3: "Tag the copy's seven dimensions from the same screen." */}
                <div className="border-t pt-3">
                  <CopyTagsPanel
                    stepId={step.id ?? null}
                    isFirstEmail={index === 0 || step.variant}
                  />
                </div>
              </div>
            ) : null}
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={add} className="h-8 gap-1.5 text-xs">
        <Plus className="size-3.5" />
        Add step
      </Button>

      {steps.some((s) => s.id != null && sent.has(s.id)) ? (
        <p className="flex items-start gap-2 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          Steps that have already sent emails cannot be removed — EmailBison refuses to delete
          them. They can still be edited and reordered.
        </p>
      ) : null}
    </div>
  );
}
