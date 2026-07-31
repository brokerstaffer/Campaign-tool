"use client";

import { useState, useSyncExternalStore } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  COLUMNS,
  COLUMN_GROUPS,
  COLUMN_PREFS_KEY,
  COLUMN_PREFS_VERSION,
  DEFAULT_VISIBLE,
} from "@/lib/analytics/columns.ts";
import { cn } from "@/lib/utils";

/**
 * Column visibility, persisted per user.
 *
 * The stored value carries a version. On mismatch it's discarded and defaults
 * return — otherwise adding a column later would leave it invisible forever for
 * anyone who had already saved a selection, which reads as the feature being
 * broken rather than as a stale preference.
 */
/*
 * localStorage is an external store, so it's read through useSyncExternalStore
 * rather than an effect + setState. That's what the primitive is for: React
 * handles the SSR snapshot and the tearing, and there's no cascading render for
 * the compiler to object to.
 *
 * getSnapshot MUST return a referentially stable value or React re-renders
 * forever — hence the cache keyed on the raw string.
 */
let cachedRaw: string | null = null;
let cachedValue: string[] = DEFAULT_VISIBLE;

function subscribe(onChange: () => void) {
  // `storage` fires for OTHER tabs, which is exactly the cross-tab sync we want.
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function getSnapshot(): string[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(COLUMN_PREFS_KEY);
  } catch {
    return DEFAULT_VISIBLE; // private browsing
  }
  if (raw === cachedRaw) return cachedValue;

  cachedRaw = raw;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    // A version bump discards the stored set, so adding a column later can't
    // leave it permanently invisible for anyone who already saved a selection.
    cachedValue =
      parsed?.version === COLUMN_PREFS_VERSION && Array.isArray(parsed.visible)
        ? parsed.visible
        : DEFAULT_VISIBLE;
  } catch {
    cachedValue = DEFAULT_VISIBLE;
  }
  return cachedValue;
}

const getServerSnapshot = (): string[] => DEFAULT_VISIBLE;

export function useColumnPrefs() {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Local echo so a click is instant rather than waiting on a storage round trip.
  const [override, setOverride] = useState<string[] | null>(null);

  function update(next: string[]) {
    setOverride(next);
    try {
      localStorage.setItem(
        COLUMN_PREFS_KEY,
        JSON.stringify({ version: COLUMN_PREFS_VERSION, visible: next }),
      );
    } catch {
      /* private browsing — the session still works, it just won't persist */
    }
  }

  return { visible: override ?? stored, setVisible: update, hydrated: true };
}

export function ColumnPicker({
  visible,
  onChange,
}: {
  visible: string[];
  onChange: (next: string[]) => void;
}) {
  const [search, setSearch] = useState("");

  const matches = (label: string) =>
    !search || label.toLowerCase().includes(search.toLowerCase());

  function toggle(key: string) {
    onChange(
      visible.includes(key) ? visible.filter((k) => k !== key) : [...visible, key],
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
          {visible.length} columns
          <ChevronDown className="size-3.5" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search columns…"
              className="h-8 pl-8 text-xs"
            />
          </div>
          <div className="mt-2 flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 flex-1 text-xs"
              onClick={() => onChange(COLUMNS.map((c) => c.key))}
            >
              Show all
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 flex-1 text-xs"
              // Never hide everything: an empty grid is indistinguishable from
              // a broken one. Sent is the anchor column.
              onClick={() => onChange(["sent"])}
            >
              Hide all
            </Button>
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {COLUMN_GROUPS.map((group) => {
            const items = COLUMNS.filter(
              (c) => c.group === group && matches(c.label),
            );
            if (!items.length) return null;

            return (
              <div key={group} className="mb-1">
                <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  {group}
                </p>
                {items.map((c) => {
                  const on = visible.includes(c.key);
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => toggle(c.key)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
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
                      {c.label}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
