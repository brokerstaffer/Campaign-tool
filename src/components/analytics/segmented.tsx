"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

/*
 * Two segmented-control shapes from the reference:
 *
 *   "inline" — a compact pill group. Volume | Rates, Preview | Spintax.
 *   "full"   — equal-width segments spanning the container, the active one
 *              OUTLINED rather than filled. That's the Charts | Clients |
 *              Campaigns row, and it reads as a section switch rather than a
 *              button group specifically because it isn't filled.
 *
 * Built on Radix ToggleGroup so roving focus, arrow-key navigation and the
 * radio semantics come for free.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  variant?: "inline" | "full";
  "aria-label": string;
}

export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  variant = "inline",
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Radix emits "" when the active item is re-clicked. Ignore it — these
      // are section switches and there is no valid "nothing selected" state.
      onValueChange={(next) => next && onValueChange(next as T)}
      aria-label={ariaLabel}
      className={cn(
        variant === "full" ? "grid w-full grid-flow-col" : "gap-0.5",
      )}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(
            "text-sm font-normal",
            variant === "full"
              ? cn(
                  "h-9 rounded-none border border-transparent bg-transparent text-muted-foreground",
                  "data-[state=on]:border-foreground data-[state=on]:bg-transparent data-[state=on]:font-medium data-[state=on]:text-foreground",
                )
              : cn(
                  "h-7 rounded-md px-2.5 text-muted-foreground",
                  "data-[state=on]:bg-accent data-[state=on]:font-medium data-[state=on]:text-foreground",
                ),
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
