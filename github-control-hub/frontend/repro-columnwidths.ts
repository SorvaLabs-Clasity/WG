/**
 * Column widths you can drag, and the layout bug that made them necessary.
 *
 * The complaint was that a widget's table left "so much free space on the
 * right" while the repository name on the left "gets smudged because it's too
 * long". That was not a tuning problem. The last column carried `w-full`, which
 * in a table means `width: 100%` — so it claimed all the width and every other
 * column collapsed to the narrowest thing it could render. The column people
 * were actually reading was the one that got nothing.
 *
 * Two things are asserted here. The arithmetic behind dragging, which is where
 * the fiddly mistakes live — a drag that inverts through its minimum, a stored
 * layout for a table whose columns have since changed. And the structure: a
 * `<colgroup>` only works if it has exactly as many entries as the body has
 * cells, and the body's cells are still hand-written per widget type.
 *
 * Run:  npx tsx repro-columnwidths.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import {
  clampWidth, widthAfterDrag, mergeWidths, widthsToStore,
  MIN_COLUMN_PX, MAX_COLUMN_PX,
} from "./src/lib/columnWidths";
import { widgetColumns, defaultWidths, layoutId } from "./src/lib/widgetColumns";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── the arithmetic ──────────────────────────────────────────────────
  {
    check("a column cannot be dragged narrower than its minimum",
      clampWidth(2) === MIN_COLUMN_PX, clampWidth(2));
    check("  nor wider than the ceiling", clampWidth(99_999) === MAX_COLUMN_PX);
    check("  and a nonsense width falls back rather than propagating NaN",
      clampWidth(NaN) === MIN_COLUMN_PX, clampWidth(NaN));
    check("  widths are whole pixels", Number.isInteger(clampWidth(120.6)));

    // The reason the drag is computed from the start width rather than
    // accumulated: dragging past the minimum and back must return to where it
    // began. Accumulating clamps away the overshoot and the column never
    // recovers.
    const start = 300;
    check("dragging right widens by the distance moved",
      widthAfterDrag(start, 120) === 420);
    check("  dragging left narrows by it", widthAfterDrag(start, -120) === 180);
    check("  pushing past the minimum stops there",
      widthAfterDrag(start, -5_000) === MIN_COLUMN_PX);
    check("  and coming back returns to the width you started from",
      widthAfterDrag(start, 0) === start,
      "accumulating per-event would have eaten the overshoot");
  }

  // ── stored layouts, for tables that have since changed ──────────────
  {
    const defaults = { index: 72, entity: 320, details: 420 };

    check("a stored width is used in place of the default",
      mergeWidths(defaults, { entity: 500 }).entity === 500);
    check("  and untouched columns keep theirs",
      mergeWidths(defaults, { entity: 500 }).index === 72);

    check("a stored width for a column that no longer exists is dropped",
      !("gone" in mergeWidths(defaults, { gone: 200 })),
      "widget columns change when a preset is edited into a query");
    check("  a column with nothing stored still gets its default",
      mergeWidths(defaults, { entity: 500 }).details === 420);

    check("a stored width outside the range is clamped, not trusted",
      mergeWidths(defaults, { entity: 99_999 }).entity === MAX_COLUMN_PX);

    // This comes out of localStorage, which is to say from an older version of
    // the app or from anyone who has opened devtools.
    for (const [label, junk] of [
      ["null", null], ["a string", "300"], ["an array", [1, 2]],
      ["a nested object", { entity: { px: 3 } }], ["NaN", { entity: NaN }],
    ] as [string, unknown][]) {
      check(`  ${label} in storage falls back to the defaults`,
        mergeWidths(defaults, junk).entity === 320,
        mergeWidths(defaults, junk).entity);
    }
  }

  // Only the differences are saved, so improving a default still reaches
  // somebody who opened the table once and never dragged anything.
  {
    const defaults = { index: 72, entity: 320 };
    check("an untouched table stores nothing at all",
      Object.keys(widthsToStore(defaults, { index: 72, entity: 320 })).length === 0);
    check("  and a dragged one stores only what moved",
      JSON.stringify(widthsToStore(defaults, { index: 72, entity: 500 })) === '{"entity":500}',
      widthsToStore(defaults, { index: 72, entity: 500 }));
  }

  // ── the columns match the cells the body actually renders ───────────
  //
  // A colgroup with the wrong number of entries does not throw. It silently
  // shifts every width one column across, which looks like a styling bug and
  // is not one.
  {
    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
    const b = page.indexOf('<tbody className="divide-y divide-slate-100');
    const body = page.slice(b, page.indexOf("</tbody>", b));
    const countTds = (from: string, to: string) => {
      const i = body.indexOf(from);
      return i < 0 ? -1 : body.slice(i, body.indexOf(to, i)).split("<td").length - 1;
    };

    const base = body.slice(0, body.indexOf("{config.type ===")).split("<td").length - 1;
    check("the always-present columns match the always-present cells",
      widgetColumns({ type: "other", hasStatus: false }).length === base, base);

    const cases: [string, Record<string, unknown>, number][] = [
      ['presetId === "dependabot"', { type: "preset", presetId: "dependabot", hasStatus: false }, base],
      ['presetId === "vuln-repos"', { type: "preset", presetId: "vuln-repos", hasStatus: false }, base],
      ['presetId === "bypasses"', { type: "preset", presetId: "bypasses", hasStatus: false }, base],
    ];
    for (const [marker, opts, baseCount] of cases) {
      const tds = countTds(marker, ")}");
      const cols = widgetColumns(opts as any).length;
      check(`  ${(opts as any).presetId}: ${cols} columns for ${baseCount + tds} cells`,
        cols === baseCount + tds, { cols, cells: baseCount + tds });
    }

    const q = widgetColumns({ type: "query", hasStatus: true }).length;
    check(`  query with a status: ${q} columns for ${base + 2} cells`,
      q === base + 2, q);
    const qn = widgetColumns({ type: "query", hasStatus: false }).length;
    check(`  query without one: ${qn} columns for ${base + 1} cells`,
      qn === base + 1, qn);
  }

  // ── and the bug that started it cannot come back ────────────────────
  {
    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
    const start = page.indexOf("function WidgetDataTable");
    const table = page.slice(start, page.indexOf("/* ─── Raw Details Modal ─── */", start));

    check("no column claims the whole width any more",
      !/<th[^>]*w-full/.test(table) && !/className="[^"]*\bw-full\b[^"]*"[^>]*>\s*(Details|Reason)/.test(table),
      "w-full on a column collapses every other column to its minimum");
    check("  the widths come from a colgroup instead",
      /<colgroup>/.test(table));
    check("  and the layout is fixed, so those widths are honoured",
      /tableLayout: "fixed"/.test(table),
      "an auto layout re-measures from content and ignores what you dragged to");
    check("  the last column takes the slack, so the right edge stays clean",
      /i === columns\.length - 1 \? undefined :/.test(table));
    check("  the name can ellipsize rather than overflow its cell",
      /font-bold text-slate-800 dark:text-slate-200 truncate/.test(table));

    const design = fs.readFileSync("./src/design/index.tsx", "utf8");
    check("the grab area is wider than the line it draws",
      /w-\[9px\]/.test(design), "a 1px target is honest and unusable");
    check("  and the gesture is not lost to the browser's scrolling",
      /touch-none/.test(design));
  }

  // Two widgets must not share one saved layout, and neither must one widget
  // across a change that alters its columns.
  {
    const a = widgetColumns({ type: "query", hasStatus: false });
    const b = widgetColumns({ type: "query", hasStatus: true });
    check("each widget has its own layout", layoutId("w1", a) !== layoutId("w2", a));
    check("  and a widget whose columns changed does not reuse the old one",
      layoutId("w1", a) !== layoutId("w1", b));
    check("  while an unchanged one is stable across reopens",
      layoutId("w1", a) === layoutId("w1", widgetColumns({ type: "query", hasStatus: false })));
    check("  defaults are keyed by column id",
      defaultWidths(a).entity === 320, defaultWidths(a));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
