/**
 * The Activity table's columns, as data rather than as seven hand-written
 * `<th>` elements.
 *
 * Same reason as `widgetColumns`: one definition drives the `<colgroup>` the
 * widths live on, the headers, and the resize handles. Those three have to
 * agree about how many columns there are and in what order, and a `<colgroup>`
 * with the wrong number of entries does not throw. It silently shifts every
 * width one column across, which looks like a styling bug and is not one.
 *
 * **Details is not always rendered.** It carries `hidden lg:table-cell` in both
 * the header and the body, so below that breakpoint the table really does have
 * six columns. The list is built from the viewport for exactly that reason: a
 * seven-entry colgroup over a six-column table is the silent misalignment
 * above.
 */

export interface ActivityColumn {
  id: string;
  label: string;
  /** Starting width in pixels. Ignored for the flexible last column. */
  width: number;
  align?: "right";
}

/**
 * @param wide   Whether the Details column is on screen. See the note above.
 * @param merged Whether the Everything view is showing, which puts an extra
 *               badge in every Action cell.
 */
export function activityColumns(wide: boolean, merged = false): ActivityColumn[] {
  const columns: ActivityColumn[] = [
    // Source and action were two columns, and the first held one icon in
    // 116px. They describe the same thing, what happened and where it came
    // from, so they are one cell with the stream carried by a colour rather
    // than by a column of its own.
    //
    // Wider than the label needs, because the cell holds more than the label:
    // the expand control, the action chip, and up to three badges. At 210 the
    // chip was clipped outright; at 300 the "important" badge still wrapped
    // under the chip on the longer event names, which is a column somebody
    // widens by hand on every visit.
    { id: "event", label: "Event", width: merged ? 390 : 350 },
    { id: "actor", label: "Who", width: 165 },
    // Repository and target were also two columns, and target is empty on a
    // good half of all rows. Stacked, the repository leads and the target sits
    // under it in the space the empty column used to occupy.
    { id: "scope", label: "Scope", width: 210 },
  ];

  // Only when it is actually on screen.
  if (wide) columns.push({ id: "details", label: "Details", width: 280 });

  // Last, so it absorbs the slack and the right edge stays clean without any
  // column claiming `width: 100%`.
  columns.push({ id: "when", label: "When", width: 150, align: "right" });

  return columns;
}

/** The default widths, in the shape `useColumnWidths` wants them. */
export function activityWidths(columns: ActivityColumn[]): Record<string, number> {
  return Object.fromEntries(columns.map(c => [c.id, c.width]));
}

/**
 * A stable id for the saved layout.
 *
 * The column set is part of it, so the six-column layout below `lg` and the
 * seven-column one above it are remembered separately rather than one being
 * applied to the other.
 *
 * So is the merged view, for the same reason one step further in: it renders an
 * extra badge in every Action cell, so a width that fits one stream does not
 * fit Everything. Sharing one id meant a width set on either was applied to
 * both, and the narrower one always won by being the one somebody dragged.
 */
export function activityLayoutId(columns: ActivityColumn[], merged = false): string {
  return `activity:${columns.map(c => c.id).join(",")}${merged ? ":merged" : ""}`;
}
