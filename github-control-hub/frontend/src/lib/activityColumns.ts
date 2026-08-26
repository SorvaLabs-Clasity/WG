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

export function activityColumns(wide: boolean): ActivityColumn[] {
  const columns: ActivityColumn[] = [
    { id: "source", label: "Source", width: 116 },
    { id: "action", label: "Action", width: 210 },
    { id: "user", label: "User", width: 170 },
    { id: "repository", label: "Repository", width: 200 },
    { id: "target", label: "Target", width: 200 },
  ];

  // Only when it is actually on screen.
  if (wide) columns.push({ id: "details", label: "Details", width: 260 });

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
 */
export function activityLayoutId(columns: ActivityColumn[]): string {
  return `activity:${columns.map(c => c.id).join(",")}`;
}
