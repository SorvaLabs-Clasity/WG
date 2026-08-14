/**
 * Search, sort and paging for a list of rows already in memory.
 *
 * Kept separate from the hook that holds the state, because the part that goes
 * wrong is the arithmetic — an off-by-one at a page boundary, a filter that
 * leaves you stranded on page 7 of 2 — and none of that needs React to test.
 * `repro-tablecontrols.ts` exercises this module directly.
 *
 * Everything here works on rows the caller already has. Nothing fetches.
 */

export type SortDir = "asc" | "desc";

export interface Column<T> {
  key: string;
  label: string;
  /** What to sort on. Strings compare case-insensitively, numbers numerically. */
  value: (row: T) => string | number | null | undefined;
}

export interface TableControlsInput<T> {
  rows: T[];
  search: string;
  /** Everything a search should match against, for one row. */
  searchText: (row: T) => string;
  columns: Column<T>[];
  sortKey: string | null;
  sortDir: SortDir;
  page: number;
  perPage: number;
}

export interface TableControlsResult<T> {
  /** The rows for the current page, after search and sort. */
  visible: T[];
  /** How many rows matched the search, before paging. */
  matchCount: number;
  totalPages: number;
  /** The page actually shown — clamped, so a stale page number cannot blank the view. */
  safePage: number;
}

/** Case-insensitive substring. Not regex: a stray `(` should narrow nothing, not throw. */
export function matchesSearch(text: string, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return text.toLowerCase().includes(needle);
}

/**
 * Compare two sort values.
 *
 * Blanks sort last in both directions. A row with no value for the column is
 * not "smallest" — it is unknown, and burying unknowns at the bottom is what
 * someone sorting a column actually wants.
 */
export function compareValues(a: string | number | null | undefined, b: string | number | null | undefined, dir: SortDir): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  let cmp: number;
  if (typeof a === "number" && typeof b === "number") {
    cmp = a - b;
  } else {
    cmp = String(a).toLowerCase().localeCompare(String(b).toLowerCase());
  }
  return dir === "asc" ? cmp : -cmp;
}

export function applyTableControls<T>(input: TableControlsInput<T>): TableControlsResult<T> {
  const { rows, search, searchText, columns, sortKey, sortDir, page, perPage } = input;

  const matched = search.trim()
    ? rows.filter(r => matchesSearch(searchText(r), search))
    : rows;

  let ordered = matched;
  const column = sortKey ? columns.find(c => c.key === sortKey) : undefined;
  if (column) {
    // Sorting a copy: the caller's array is React state elsewhere, and sorting
    // in place would mutate it.
    //
    // Stable, because Array.prototype.sort is required to be since ES2019 —
    // so re-sorting by a column full of ties leaves the previous order intact
    // rather than reshuffling rows under the reader.
    ordered = [...matched].sort((x, y) => compareValues(column.value(x), column.value(y), sortDir));
  }

  const totalPages = Math.max(1, Math.ceil(ordered.length / perPage));
  // Clamped rather than trusted. Narrowing a search while on a late page would
  // otherwise show an empty table that looks like "no results".
  const safePage = Math.min(Math.max(1, page), totalPages);
  const visible = ordered.slice((safePage - 1) * perPage, safePage * perPage);

  return { visible, matchCount: ordered.length, totalPages, safePage };
}
