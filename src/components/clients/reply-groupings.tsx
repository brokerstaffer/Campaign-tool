"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/*
 * Which breakdowns a client sees on the Replies view (spec §5.5).
 *
 * "These groupings are configurable per client. Brokerage, office, county and
 *  sales volume are the ones that matter for this client; another client can be
 *  set up with their own list without a rebuild."
 *
 * The database has supported this since 027 — a NULL client_id row is the
 * default, a client row overrides it — but nothing could edit it, so
 * "configurable" meant "someone writes SQL". This is the screen.
 *
 * TURNING ONE OFF IS A COPY-ON-WRITE, NOT A DELETE. The default row is shared by
 * every client, so switching it off there would remove the card for all of them.
 * The API writes a client-specific row instead; the resolver already prefers it.
 * That is invisible here on purpose — the operator should think "hide this card
 * for this client", not about row ownership.
 */

interface Dimension {
  key: string;
  label: string;
  source: string;
  active: boolean;
  overridden: boolean;
}

export function ReplyGroupings({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ dimensions: Dimension[] }>({
    queryKey: ["reply-dimensions", clientId],
    queryFn: async () => {
      const response = await fetch(`/api/reply-dimensions?client_id=${clientId}`);
      if (!response.ok) throw new Error("Failed to load groupings");
      return response.json();
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ key, active }: { key: string; active: boolean }) => {
      const response = await fetch("/api/reply-dimensions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, key, active }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not save");
      return body;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["reply-dimensions", clientId] });
      // The Replies view reads this list to decide which cards to draw.
      void queryClient.invalidateQueries({ queryKey: ["reply-breakdowns"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Loading groupings…
      </div>
    );
  }

  const dimensions = data?.dimensions ?? [];
  const activeCount = dimensions.filter((d) => d.active).length;

  return (
    <div className="space-y-2">
      <div>
        <p className="text-xs font-medium">Reply groupings</p>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
          Which breakdown cards {clientName} sees on the Replies view.{" "}
          {activeCount === 0
            ? "With none selected the view falls back to showing nothing — pick at least one."
            : `${activeCount} of ${dimensions.length} shown.`}
        </p>
      </div>

      <ul className="grid gap-1.5 sm:grid-cols-2">
        {dimensions.map((d) => (
          <li key={d.key}>
            <label
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors",
                d.active ? "bg-card" : "bg-muted/40 text-muted-foreground",
              )}
            >
              <input
                type="checkbox"
                checked={d.active}
                disabled={toggle.isPending}
                onChange={(e) => toggle.mutate({ key: d.key, active: e.target.checked })}
                className="size-3.5 accent-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{d.label}</span>
              {/* Says this client differs from the default, so an unexpected
                  set of cards is traceable rather than mysterious. */}
              {d.overridden ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                  custom
                </span>
              ) : null}
            </label>
          </li>
        ))}
      </ul>

      {toggle.error ? (
        <p className="text-[11px] text-red-700">{toggle.error.message}</p>
      ) : null}
    </div>
  );
}
