"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { SortState } from "@/hooks/use-table-sort";
import { cn } from "@/lib/utils";

/*
 * One sortable column header, for every table in the product.
 *
 * There were two of these before, written inline in two files, differing
 * subtly, both descending-only, both indicating state with a text " ↓" glued to
 * the label. Neither carried `aria-sort`, so the sort was invisible to a screen
 * reader entirely.
 *
 * The arrow is only drawn on the active column; inactive sortable columns get a
 * faint up/down glyph on hover, so a header that CAN be sorted looks different
 * from one that cannot — previously indistinguishable until you clicked.
 */

export function SortableHeader({
  label,
  sortKey,
  sort,
  onToggle,
  align = "right",
  className,
  title,
}: {
  label: React.ReactNode;
  /** Omit to render a plain, unsortable header. */
  sortKey?: string;
  sort: SortState | null;
  onToggle: (key: string) => void;
  align?: "left" | "right";
  className?: string;
  title?: string;
}) {
  const active = sortKey != null && sort?.key === sortKey;
  const cell = cn(
    "whitespace-nowrap px-3 py-2 font-medium",
    align === "right" ? "text-right" : "text-left",
    className,
  );

  if (!sortKey) {
    return (
      <th scope="col" className={cell} title={title}>
        {label}
      </th>
    );
  }

  return (
    <th
      scope="col"
      className={cell}
      // The one thing that makes the sort perceivable without sight of the icon.
      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
      title={title}
    >
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={cn(
          "group inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active && "text-foreground",
        )}
        // Says what the NEXT click does, which is the part a three-state control
        // has to spell out — nobody guesses that a third click resets.
        title={
          active
            ? sort!.dir === "asc"
              ? "Sorted low to high — click for high to low"
              : "Sorted high to low — click to clear"
            : "Click to sort low to high"
        }
      >
        <span>{label}</span>
        {active ? (
          sort!.dir === "asc" ? (
            <ArrowUp className="size-3 shrink-0" />
          ) : (
            <ArrowDown className="size-3 shrink-0" />
          )
        ) : (
          <ChevronsUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-40" />
        )}
      </button>
    </th>
  );
}
