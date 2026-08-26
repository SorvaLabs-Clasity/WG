/**
 * The columns a widget's detail table shows, as data rather than as JSX.
 *
 * These were four sets of conditional `<th>`s. Turning them into a list is what
 * lets the same definition drive the `<colgroup>` the widths live on, the
 * headers, and the resize handles — three things that have to agree about how
 * many columns there are and in what order, and that previously agreed only
 * because someone kept them in step by hand.
 *
 * **The last column is the flexible one.** Every other column is an exact pixel
 * width; the last takes whatever is left over. That is what stops the table
 * having a ragged right edge without any column having to claim `width: 100%` —
 * which is what went wrong before. `w-full` on the Details column meant it
 * claimed *all* the width and every other column collapsed to the narrowest
 * thing it could render, so the repository name — the one people were reading —
 * was squeezed to nothing while the empty column beside it took half the screen.
 */

export interface WidgetColumn {
  id: string;
  label: string;
  /** Starting width in pixels. Ignored for the flexible last column. */
  width: number;
  align?: "center";
  /** Header colour, for the severity columns that carry meaning in their tint. */
  headClass?: string;
}

/** Wide by default: this holds a repository name, and they are long. */
const ENTITY_WIDTH = 320;

export function widgetColumns(opts: {
  type: string;
  presetId?: string;
  hasStatus: boolean;
  /**
   * The rows carry an owning team. Driven by the data rather than by the check
   * id, so any check that starts returning one gets the column without this
   * file needing to know which checks those are.
   */
  hasOwner?: boolean;
  /** The rows report a repository visibility, so public and internal can be told apart. */
  hasVisibility?: boolean;
}): WidgetColumn[] {
  const { type, presetId, hasStatus, hasOwner, hasVisibility } = opts;

  const columns: WidgetColumn[] = [
    { id: "index", label: "#", width: 72 },
    // Named for what the rows actually are. Renovate rows are pull requests
    // whose entity is the repository they sit on, and several rows can share
    // one, so "Entity" over a column of repeated repository names reads as a
    // mistake rather than as a grouping.
    {
      id: "entity",
      label: presetId === "renovate-open" ? "Repository" : "Entity",
      width: presetId === "renovate-open" ? 240 : ENTITY_WIDTH,
    },
  ];

  if (type === "preset" && presetId === "dependabot") {
    columns.push(
      { id: "critical", label: "Critical", width: 104, align: "center", headClass: "text-rose-600 dark:text-red-400" },
      { id: "high", label: "High", width: 96, align: "center", headClass: "text-orange-500 dark:text-orange-400" },
      { id: "medium", label: "Medium", width: 104, align: "center", headClass: "text-amber-600 dark:text-amber-400" },
      { id: "low", label: "Low", width: 96, align: "center", headClass: "text-slate-500 dark:text-slate-400" },
      { id: "total", label: "Total", width: 96, align: "center" },
    );
  }

  if (type === "preset" && presetId === "vuln-repos") {
    columns.push(
      { id: "worst", label: "Worst", width: 128, align: "center" },
      { id: "alerts", label: "Alerts", width: 104, align: "center" },
    );
  }

  // Renovate rows are pull requests, not repositories, so the entity column
  // alone left the table listing the same repository name several times over
  // with nothing to tell the rows apart. Everything below is already on the
  // row; it was simply never given a column.
  if (type === "preset" && presetId === "renovate-open") {
    columns.push(
      { id: "pr", label: "Pull request", width: 420 },
      { id: "age", label: "Open for", width: 110, align: "center" },
      { id: "link", label: "GitHub", width: 96, align: "center" },
    );
  }

  if (type === "preset" && presetId === "bypasses") {
    columns.push(
      { id: "bypasses", label: "Bypasses", width: 120 },
      { id: "reason", label: "Reason", width: 360 },
    );
  }

  // Public and internal are different findings and must not look alike. Driven
  // by the data, like the owner column, so any check that starts reporting a
  // visibility gets the column without this file knowing which checks those are.
  if (type === "query" && hasVisibility) {
    columns.push({ id: "visibility", label: "Visibility", width: 128, align: "center" });
  }

  if (type === "query" && hasStatus) {
    columns.push({ id: "status", label: "Status", width: 104, align: "center" });
  }

  // Before Details, because "who do I ask" is read alongside the repository
  // name rather than after the explanation of what is wrong with it.
  //
  // Labelled "Owner" rather than "Owning team" because it falls back to the
  // person who has committed most where no team owns the repository — the
  // column answers one question with two kinds of answer.
  if (type === "query" && hasOwner) {
    columns.push({ id: "owner", label: "Owner", width: 220 });
  }

  if (type === "query") {
    columns.push({ id: "details", label: "Details", width: 420 });
  }

  return columns;
}

/** The default widths, in the shape `useColumnWidths` wants them. */
export function defaultWidths(columns: WidgetColumn[]): Record<string, number> {
  return Object.fromEntries(columns.map(c => [c.id, c.width]));
}

/**
 * A stable id for one widget's layout, so two widgets do not share one.
 *
 * The column set is part of it: a widget edited from a preset into a query has
 * different columns, and a saved layout for the old ones describes a table that
 * no longer exists.
 */
export function layoutId(widgetId: string, columns: WidgetColumn[]): string {
  return `widget:${widgetId}:${columns.map(c => c.id).join(",")}`;
}
