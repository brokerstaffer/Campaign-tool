"use client";

import { useState } from "react";
import { CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useAnalyticsFilters } from "./filters-context";
import { rangeLabel } from "@/lib/analytics/format.ts";
import { toISODate } from "@/lib/analytics/query-params.ts";

/*
 * Ported from outreachify-revyops' shared/date-range-picker, with one important
 * behavioural change: revyops commits on every calendar click, so picking a
 * start date immediately refetches everything against a half-formed range.
 *
 * Here the selection is DRAFT state and nothing reloads until Apply — which is
 * both what the spec requires and what stops a 90-day range change from firing
 * three expensive queries on the way to the one you wanted.
 */

function parseISO(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d); // local midnight; the calendar is a local widget
}

export function RangePicker() {
  const { filters, setFilters } = useAnalyticsFilters();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>();

  /*
   * Seed the draft from the committed range at OPEN time, in the event handler
   * rather than an effect. An effect that setStates on `open` triggers a
   * cascading render (and the React Compiler lint rightly rejects it); doing it
   * here means the popover renders once, already correct. Clearing on close is
   * what stops an abandoned selection leaking into the next interaction.
   */
  function onOpenChange(next: boolean) {
    setDraft(
      next
        ? { from: parseISO(filters.from), to: parseISO(filters.to) }
        : undefined,
    );
    setOpen(next);
  }

  function apply() {
    if (!draft?.from) return;
    const to = draft.to ?? draft.from;
    setFilters({
      preset: "custom",
      from: toISODate(
        new Date(
          Date.UTC(
            draft.from.getFullYear(),
            draft.from.getMonth(),
            draft.from.getDate(),
          ),
        ),
      ),
      to: toISODate(
        new Date(Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())),
      ),
    });
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs font-normal"
        >
          <CalendarIcon className="size-3.5 text-muted-foreground" />
          {rangeLabel(filters.from, filters.to)}
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          numberOfMonths={2}
          defaultMonth={draft?.from}
          selected={draft}
          onSelect={setDraft}
          autoFocus
        />
        <div className="flex items-center justify-between border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {draft?.from
              ? rangeLabel(
                  toISODate(
                    new Date(
                      Date.UTC(
                        draft.from.getFullYear(),
                        draft.from.getMonth(),
                        draft.from.getDate(),
                      ),
                    ),
                  ),
                  toISODate(
                    new Date(
                      Date.UTC(
                        (draft.to ?? draft.from).getFullYear(),
                        (draft.to ?? draft.from).getMonth(),
                        (draft.to ?? draft.from).getDate(),
                      ),
                    ),
                  ),
                )
              : "Pick a start date"}
          </span>
          <Button size="sm" className="h-7" disabled={!draft?.from} onClick={apply}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
