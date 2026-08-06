"use client";

import { useState } from "react";

/*
 * Column sorting, shared by every table in the product.
 *
 * THREE CLICKS, IN THIS ORDER: ascending, then descending, then back to the
 * table's own order.
 *
 * The third click is the one worth having. Every table here already arrives in
 * a considered order — campaigns by volume, copy by positive rate with untagged
 * sunk to the bottom, the funnel by stage — and without a way back, sorting a
 * column is a one-way door: you can never return to the view the table was
 * designed to show without reloading the page.
 *
 * Before this, sorting was descending-only and clicking an active column did
 * nothing, so "who is worst" was unanswerable on every table in the app.
 */

export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
}

export function useTableSort(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);

  const toggle = (key: string) =>
    setSort((current) => {
      if (!current || current.key !== key) return { key, dir: "asc" };
      if (current.dir === "asc") return { key, dir: "desc" };
      return null; // third click — back to the table's own order
    });

  return { sort, toggle, setSort };
}

/**
 * Compares two cell values.
 *
 * NULLS ALWAYS SORT LAST, in both directions, and that is deliberate. A dash
 * means "no data" (CLAUDE.md rule 1); floating those to the top of an ascending
 * sort would present them as the smallest values, which is a different and
 * false claim. They sit at the end either way, where they read as "no answer"
 * rather than "worst".
 */
function compare(a: unknown, b: unknown, dir: SortDir): number {
  const aEmpty = a === null || a === undefined || (typeof a === "number" && !Number.isFinite(a));
  const bEmpty = b === null || b === undefined || (typeof b === "number" && !Number.isFinite(b));
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const sign = dir === "asc" ? 1 : -1;

  if (typeof a === "number" && typeof b === "number") return (a - b) * sign;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (Number(a) - Number(b)) * sign;
  }
  // Numeric-aware so "Campaign 2" sorts before "Campaign 10".
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }) * sign;
}

/**
 * Sorts a copy of `rows`. Returns the input untouched when no sort is active,
 * so the table's own order survives the third click.
 */
export function sortRows<T>(
  rows: T[],
  sort: SortState | null,
  value: (row: T, key: string) => unknown,
): T[] {
  if (!sort) return rows;
  return [...rows].sort((a, b) => compare(value(a, sort.key), value(b, sort.key), sort.dir));
}
