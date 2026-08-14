import { useState, useMemo, useEffect } from "react";
import { applyTableControls, type Column, type SortDir } from "../lib/tableControls";

export type { Column, SortDir };

/**
 * Search, sort and paging for a result table.
 *
 * Holds the state; the arithmetic lives in lib/tableControls.ts, which
 * repro-tablecontrols.ts tests directly.
 *
 * A page tells this what its rows mean — what a search should match, and which
 * columns can be sorted — and nothing else. It does not need to know how any of
 * it works.
 */
export function useTableControls<T>(
  rows: T[],
  opts: {
    searchText: (row: T) => string;
    columns: Column<T>[];
    perPage?: number;
    /** Column sorted on first render, if any. */
    initialSortKey?: string;
    initialSortDir?: SortDir;
  },
) {
  const perPage = opts.perPage ?? 25;
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(opts.initialSortKey ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(opts.initialSortDir ?? "asc");
  const [page, setPage] = useState(1);

  // Typing should take you to the first page of what you just asked for, not
  // leave you on the page you happened to be on. applyTableControls clamps as
  // well, so the view is never blank in the gap before this runs.
  useEffect(() => { setPage(1); }, [search, sortKey, sortDir]);

  const result = useMemo(
    () => applyTableControls({
      rows, search, searchText: opts.searchText, columns: opts.columns,
      sortKey, sortDir, page, perPage,
    }),
    // opts is rebuilt on every render by most callers, so depending on it
    // directly would recompute constantly. The fields that change the answer
    // are listed instead.
    [rows, search, sortKey, sortDir, page, perPage],
  );

  /** Click a header: same column flips direction, a new column starts ascending. */
  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return {
    search, setSearch,
    sortKey, sortDir, toggleSort,
    page: result.safePage, setPage,
    totalPages: result.totalPages,
    visible: result.visible,
    matchCount: result.matchCount,
    /** True when the list is long enough that paging is worth showing. */
    paged: result.totalPages > 1,
    /** True when a search is narrowing the list, for "showing X of Y" copy. */
    filtered: search.trim().length > 0,
    totalCount: rows.length,
  };
}
