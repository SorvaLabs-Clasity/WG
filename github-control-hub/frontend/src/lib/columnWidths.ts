/**
 * How wide each column of a table is, and what happens when you drag one.
 *
 * Kept out of the component because the part that goes wrong is the
 * arithmetic and the bookkeeping — a drag that inverts past the minimum, a
 * stored width for a column that no longer exists, a saved layout from a
 * widget that has since changed shape. None of that needs React to test.
 *
 * **Widths are independent.** Dragging one column changes that column and
 * nothing else; the table grows or shrinks and its container scrolls. The
 * alternative — taking the space from the neighbour — keeps the total fixed but
 * means every drag moves two columns, and the one you were not dragging is the
 * one you were reading.
 */

/** Narrow enough to be useful, wide enough to still show a few characters. */
export const MIN_COLUMN_PX = 72;

/**
 * A ceiling exists only so a runaway drag cannot produce a table megapixels
 * wide, which is recoverable but looks broken.
 */
export const MAX_COLUMN_PX = 1200;

export interface ColumnWidths {
  [columnId: string]: number;
}

/** One width, kept inside the range and always a whole pixel. */
export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return MIN_COLUMN_PX;
  return Math.round(Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, px)));
}

/**
 * The width a column should take, given where the drag started and how far the
 * pointer has moved.
 *
 * Deliberately computed from the *start* width and the total delta rather than
 * accumulated per pointer event: accumulating drifts, and it also means a drag
 * that pushes past the minimum and comes back does not return to where it
 * started — the clamp would have eaten the difference on the way down.
 */
export function widthAfterDrag(startPx: number, deltaPx: number): number {
  return clampWidth(startPx + deltaPx);
}

/**
 * Stored widths laid over the defaults for the columns actually on screen.
 *
 * Both halves matter. A widget's columns change — a preset is edited, a query
 * starts returning a status where it did not before — so a stored layout is
 * always a guess about a table that may no longer have those columns. Unknown
 * ids are dropped rather than kept, and a column with nothing stored takes its
 * default rather than disappearing or collapsing to zero.
 *
 * Anything unparseable is treated as absent. This comes from localStorage,
 * which is to say from a previous version of this app, or from anyone who has
 * opened devtools.
 */
export function mergeWidths(
  defaults: ColumnWidths, stored: unknown,
): ColumnWidths {
  const out: ColumnWidths = { ...defaults };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;

  for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
    // A column that is no longer on screen: forget it rather than carry it.
    if (!(id in defaults)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[id] = clampWidth(value);
  }
  return out;
}

/**
 * Only what somebody actually changed.
 *
 * Storing every width would freeze today's defaults into every saved layout,
 * so improving a default would never reach anyone who had opened the table
 * once. Storing only the differences means untouched columns keep following
 * the default.
 */
export function widthsToStore(
  defaults: ColumnWidths, current: ColumnWidths,
): ColumnWidths {
  const out: ColumnWidths = {};
  for (const [id, px] of Object.entries(current)) {
    if (!(id in defaults)) continue;
    if (defaults[id] === px) continue;
    out[id] = px;
  }
  return out;
}

/** Where one table's layout lives. Per table, so two do not share a layout. */
export function storageKey(tableId: string): string {
  return `columnWidths:${tableId}`;
}
