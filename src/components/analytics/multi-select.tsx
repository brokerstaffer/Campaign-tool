"use client";

import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface Option {
  value: string;
  label: string;
  /** Optional trailing hint, e.g. volume, to make the list scannable. */
  hint?: string;
}

/**
 * Searchable multi-select for the filter bar.
 *
 * Selected values render as removable chips beside the trigger, so what's
 * filtering the page is visible without opening the popover — a bare
 * "3 selected" makes you click to find out what you're looking at.
 */
export function MultiSelect({
  label,
  options,
  selected,
  onChange,
  emptyText = "No results found",
  maxChips = 2,
}: {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (next: string[]) => void;
  emptyText?: string;
  maxChips?: number;
}) {
  const [open, setOpen] = useState(false);

  const chosen = options.filter((o) => selected.includes(o.value));
  const visible = chosen.slice(0, maxChips);
  const overflow = chosen.length - visible.length;

  function toggle(value: string) {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  }

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "h-7 gap-1 px-2 text-xs font-normal",
              selected.length && "text-foreground",
            )}
          >
            {label}
            <ChevronDown className="size-3 text-muted-foreground" />
          </Button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-72 p-0">
          <Command>
            <CommandInput placeholder={`Search ${label.toLowerCase()}…`} className="h-9 text-xs" />
            <CommandList>
              <CommandEmpty className="py-6 text-center text-xs text-muted-foreground">
                {emptyText}
              </CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const on = selected.includes(o.value);
                  return (
                    <CommandItem
                      key={o.value}
                      value={o.label}
                      onSelect={() => toggle(o.value)}
                      className="gap-2 text-xs"
                    >
                      <span
                        className={cn(
                          "flex size-3.5 shrink-0 items-center justify-center rounded border",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input",
                        )}
                      >
                        {on ? <Check className="size-2.5" /> : null}
                      </span>
                      <span className="flex-1 truncate">{o.label}</span>
                      {o.hint ? (
                        <span className="tnum shrink-0 text-[10px] text-muted-foreground">
                          {o.hint}
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {visible.map((o) => (
        <span
          key={o.value}
          className="inline-flex max-w-[160px] items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[11px]"
        >
          <span className="truncate">{o.label}</span>
          <button
            type="button"
            onClick={() => toggle(o.value)}
            aria-label={`Remove ${o.label}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => onChange([])}
          title="Clear all"
          className="rounded border bg-card px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          +{overflow} more
        </button>
      ) : null}
    </div>
  );
}
