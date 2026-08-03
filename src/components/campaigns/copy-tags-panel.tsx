"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import { COPY_DIMENSIONS } from "@/lib/analytics/copy-dimensions.ts";
import { cn } from "@/lib/utils";

/*
 * Tagging a step's seven copy dimensions (spec §6.3).
 *
 * "Tagging happens where the copy lives — on each email in the sequence editor
 * there's a small panel for setting its seven dimensions."
 *
 * Two things about this panel are deliberately unlike the editor around it:
 *
 *  1. IT SAVES IMMEDIATELY, while the sequence itself saves only on Save. That
 *     is not an inconsistency to iron out — these tags are local notes that
 *     never reach EmailBison and change nothing a prospect receives, so the
 *     ceremony that protects live email would only be friction here. The panel
 *     says so, so the difference is stated rather than discovered.
 *  2. VALUES ARE A COMBOBOX, not free text. A field with no memory produces
 *     "Question", "question" and "Questions" as three separate values, and the
 *     dimension table then measures typing rather than copy.
 */

interface TagState {
  tags: Record<string, { value: string; source: string }>;
  known: Record<string, string[]>;
}

export function CopyTagsPanel({ stepId }: { stepId: number | null }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Record<string, string>>({});

  const { data, isLoading } = useQuery<TagState>({
    queryKey: ["copy-tags", stepId],
    queryFn: async () => {
      const response = await fetch(`/api/copy/tags?step_id=${stepId}`);
      if (!response.ok) throw new Error("Could not load copy tags");
      return response.json();
    },
    enabled: stepId != null,
    staleTime: 30_000,
  });

  const save = useMutation({
    mutationFn: async (tags: Record<string, string | null>) => {
      const response = await fetch("/api/copy/tags", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sequenceStepId: stepId, tags }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save tags");
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["copy-tags", stepId] });
      // The dimension tables downstream are now stale.
      void queryClient.invalidateQueries({ queryKey: ["copy"] });
    },
  });

  // A step added in this session has no id until the sequence is saved, so
  // there is nothing to hang a tag on yet.
  if (stepId == null) {
    return (
      <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Save the sequence first — a new step has to exist before its copy can be tagged.
      </p>
    );
  }

  const tagged = Object.keys(data?.tags ?? {}).length;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <p className="text-[11px] font-medium">Copy dimensions</p>
        <p className="text-[11px] text-muted-foreground">
          {tagged} of {COPY_DIMENSIONS.length} tagged · saves immediately, never sent to
          EmailBison
        </p>
        {save.isPending || isLoading ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : null}
        {save.isSuccess && !save.isPending ? (
          <Check className="size-3 text-emerald-600" />
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {COPY_DIMENSIONS.map((dimension) => {
          const current = data?.tags?.[dimension.key];
          const value = draft[dimension.key] ?? current?.value ?? "";
          const listId = `copy-${dimension.key}-${stepId}`;
          // Existing values first, then the spec's starting suggestions.
          const options = [
            ...(data?.known?.[dimension.key] ?? []),
            ...dimension.suggestions.filter(
              (s) => !(data?.known?.[dimension.key] ?? []).includes(s),
            ),
          ];

          return (
            <label key={dimension.key} className="block">
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {dimension.label}
                {current?.source === "suggested" ? (
                  // §6.3: a suggestion must be visibly a suggestion until
                  // someone confirms it, or a guess quietly becomes evidence.
                  <span className="rounded bg-blue-100 px-1 text-[10px] text-blue-900">
                    suggested
                  </span>
                ) : null}
              </span>
              <input
                list={listId}
                value={value}
                placeholder={dimension.suggestions[0]}
                onChange={(e) => setDraft({ ...draft, [dimension.key]: e.target.value })}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === (current?.value ?? "")) return;
                  save.mutate({ [dimension.key]: next || null });
                }}
                className={cn(
                  "mt-0.5 h-7 w-full rounded-md border bg-background px-2 text-xs",
                  current?.source === "suggested" && "border-blue-300",
                )}
              />
              <datalist id={listId}>
                {options.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </label>
          );
        })}
      </div>

      {save.error ? (
        <p className="rounded-md border border-red-300/60 bg-red-50 p-2 text-[11px] text-red-800">
          {save.error.message}
        </p>
      ) : null}
    </div>
  );
}
