import type { WidgetColumn } from "./widgetColumns";

/**
 * Per-column filters on a personal widget.
 *
 * A check answers a question about the whole organization. On a shared board
 * that is the point; on your own it usually is not, because "which repositories
 * have gone dormant" is a hundred rows of which four are yours. Narrowing the
 * check itself is not an option — the checks are shared, and a personal board
 * that could redefine them would change what everybody else sees — so the
 * narrowing happens to the rows.
 *
 * Filters are stored on the widget rather than held in the page, because a
 * dashboard you have to re-narrow every time you open it is not a dashboard.
 */

export type FilterKind = "text" | "enum" | "number";

export interface WidgetFilter {
  /** The column id, as `widgetColumns` names it. */
  column: string;
  /**
   * Whether the listed values are what to keep or what to drop.
   *
   * Both are wanted in practice: "only my repositories" and "anything except
   * the archived ones" are the two ways people describe the same board.
   */
  mode?: "include" | "exclude";
  /** Text fragments or exact enum values, depending on the column's kind. */
  values?: string[];
  /** Inclusive bounds, for a numeric column. Null means unbounded that side. */
  min?: number | null;
  max?: number | null;
}

/**
 * Columns that cannot be filtered, and why.
 *
 * `index` is the row number, which is a property of the list rather than of the
 * row. `link` is a button. `details` is excluded on purpose: it is prose
 * assembled per row, so a filter on it would be a text search wearing a
 * filter's clothes, and the alarm on the same check already lets that text be
 * matched properly.
 */
const NOT_FILTERABLE = new Set(["index", "link", "details"]);

/** How a row answers for one column. */
export function valueFor(item: any, column: string): unknown {
  if (!item) return undefined;
  switch (column) {
    // The subject of the row, whichever kind it is. One column in the table,
    // three possible fields underneath, and a filter has to see the same thing
    // the reader does.
    case "entity": return item.repo ?? item.user ?? item.team;
    case "pr": return item.title;
    case "age": return item.ageDays;
    default: return item[column];
  }
}

/** Counts, which get a range rather than a list. */
const NUMERIC = ["critical", "high", "medium", "low", "total", "alerts", "bypasses", "age"];

/**
 * The columns whose values are a closed set the app itself defines.
 *
 * Closed is the whole test, and it is not the same as short. Status has two
 * values because fail and pass are all there will ever be. Owner might also
 * have two today, and one new team makes that wrong.
 *
 * This used to be inferred: any column with twelve or fewer distinct values in
 * the rows became a list to tick. Owner and Entity are names, so they landed
 * on the wrong side of it and lost their text field entirely. Not partly, but
 * entirely: a team absent from the rows on screen could not be filtered for at
 * all, and a saved filter built from the values present the day it was made
 * quietly stops offering the right answer later.
 *
 * So the guess is gone. Naming the closed vocabularies is a list this app can
 * actually be sure about, and everything else is typed into. The failure mode
 * of the new rule is a column that could have offered a list and instead lets
 * somebody type, which is an inconvenience; the failure mode of the old one
 * was not being able to express the filter at all.
 */
const CLOSED_VOCABULARY = ["status", "visibility", "worst", "ownerKind"];

/** Whether a column holds numbers, a closed set of values, or free text. */
function kindOf(column: string, items: any[]): FilterKind {
  if (NUMERIC.includes(column)) return "number";
  if (CLOSED_VOCABULARY.includes(column)) return "enum";

  // A column that turns out to hold numbers still gets a range, since typing
  // "3" to mean "3 or more" is not something a text match can express.
  for (const item of items) {
    const v = valueFor(item, column);
    if (v === undefined || v === null || v === "") continue;
    return typeof v === "number" ? "number" : "text";
  }
  return "text";
}

export interface FilterableColumn {
  id: string;
  label: string;
  kind: FilterKind;
  /** Every value present in the rows, for an enum column. */
  options: string[];
}

/**
 * What can be filtered on this widget, given what its rows actually contain.
 *
 * Driven by the rows rather than by a table of check ids, so a check that
 * starts returning a new field becomes filterable without this file being
 * edited — the same rule the columns themselves already follow.
 */
export function filterableColumns(columns: WidgetColumn[], items: any[]): FilterableColumn[] {
  const out: FilterableColumn[] = [];
  for (const c of columns) {
    if (NOT_FILTERABLE.has(c.id)) continue;
    const kind = kindOf(c.id, items);
    const options = kind === "enum"
      ? [...new Set(items.map(i => valueFor(i, c.id))
          .filter(v => v !== undefined && v !== null && v !== "")
          .map(String))].sort()
      : [];
    // An enum column with nothing in it offers a list of no choices, which
    // reads as a broken control rather than as an empty organization.
    if (kind === "enum" && options.length === 0) continue;
    out.push({ id: c.id, label: c.label, kind, options });
  }
  return out;
}

/** Whether a filter would actually narrow anything. */
export function isActive(f: WidgetFilter): boolean {
  if (f.values && f.values.length > 0) return true;
  return typeof f.min === "number" || typeof f.max === "number";
}

function matchesOne(item: any, f: WidgetFilter): boolean {
  const raw = valueFor(item, f.column);

  if (typeof f.min === "number" || typeof f.max === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) return false;
    if (typeof f.min === "number" && n < f.min) return false;
    if (typeof f.max === "number" && n > f.max) return false;
    return true;
  }

  const values = (f.values ?? []).filter(v => v.trim() !== "");
  if (values.length === 0) return true;

  // Missing is not a match. A row with no owner does not belong in a board
  // narrowed to two owners, and treating absence as a wildcard would quietly
  // put the widest rows back.
  if (raw === undefined || raw === null || raw === "") return false;

  // Case-insensitive substring, because the values people type are repository
  // and account names they half-remember. An exact match would make a filter
  // that returns nothing look like a check that found nothing.
  const text = String(raw).toLowerCase();
  return values.some(v => text.includes(v.trim().toLowerCase()));
}

/**
 * Narrow rows by every active filter.
 *
 * Filters combine with AND across columns and OR within one, which is how
 * people describe a board out loud: "my two repositories, only the failing
 * ones".
 */
export function applyWidgetFilters(items: any[], filters?: WidgetFilter[]): any[] {
  const active = (filters ?? []).filter(isActive);
  if (active.length === 0) return items;

  return items.filter(item => active.every(f => {
    const hit = matchesOne(item, f);
    // Bounds have no sensible exclude form, so mode is ignored for them: a
    // range with a hole in the middle is two filters, not one inverted.
    if (typeof f.min === "number" || typeof f.max === "number") return hit;
    return f.mode === "exclude" ? !hit : hit;
  }));
}

/** How many filters are narrowing this widget, for a badge. */
export function activeFilterCount(filters?: WidgetFilter[]): number {
  return (filters ?? []).filter(isActive).length;
}

/** One filter said in words, for a chip on the card. */
export function describeFilter(f: WidgetFilter, label: string): string {
  if (typeof f.min === "number" && typeof f.max === "number") return `${label} ${f.min}–${f.max}`;
  if (typeof f.min === "number") return `${label} ≥ ${f.min}`;
  if (typeof f.max === "number") return `${label} ≤ ${f.max}`;
  const values = (f.values ?? []).filter(v => v.trim() !== "");
  const verb = f.mode === "exclude" ? "not" : "is";
  if (values.length === 1) return `${label} ${verb} ${values[0]}`;
  return `${label} ${verb} ${values.length} values`;
}
