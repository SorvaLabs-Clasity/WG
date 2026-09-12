/**
 * Column widths you can drag, and the layout bug that made them necessary.
 *
 * The complaint was that a widget's table left "so much free space on the
 * right" while the repository name on the left "gets smudged because it's too
 * long". That was not a tuning problem. The last column carried `w-full`, which
 * in a table means `width: 100%`, so it claimed all the width and every other
 * column collapsed to the narrowest thing it could render. The column people
 * were actually reading was the one that got nothing.
 *
 * Two things are asserted here. The arithmetic behind dragging, which is where
 * the fiddly mistakes live, a drag that inverts through its minimum, a stored
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
      ['presetId === "renovate-open"', { type: "preset", presetId: "renovate-open", hasStatus: false }, base],
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

    // ── the owning team column ────────────────────────────────────────
    //
    // Conditional on the rows carrying the field, so the column and the cell
    // are gated separately and could drift apart, which does not throw, it
    // shifts every width one column across.
    const withOwner = widgetColumns({ type: "query", hasStatus: false, hasOwner: true });
    check("  a check that reports an owner gets a column for it",
      withOwner.length === qn + 1 && withOwner.some(c => c.id === "owner"),
      withOwner.map(c => c.id));
    check("    placed before Details, beside the name it belongs to",
      withOwner.findIndex(c => c.id === "owner") < withOwner.findIndex(c => c.id === "details"));
    check("    and absent when no row carries one",
      !widgetColumns({ type: "query", hasStatus: false }).some(c => c.id === "owner"));

    const ownerCell = /\{config\.type === "query" && columns\.some\(c => c\.id === "owner"\) && \(/;
    check("    the body renders a cell under exactly the same condition",
      ownerCell.test(page),
      "a column without its cell shifts every width one across");
    // Four tiers, and the label is what tells them apart, a team slug, a
    // username and a git author name all render identically otherwise.
    check("    an unregistered committer is labelled as having no account",
      /no account/.test(page),
      "a name out of git metadata rendered bare reads as a GitHub user");
    for (const kind of ["team", "admin", "top committer"]) {
      check(`    the cell can say "${kind}"`, page.includes(`"${kind}"`) || page.includes(`: "${kind}"`) || page.includes(`>${kind}`),
        kind);
    }
    check("    every owner is labelled with its kind",
      /item\.ownerKind === "team" \? "team"/.test(page)
      && /item\.ownerKind === "admin" \? "admin"/.test(page),
      "a team slug and a username look the same without it");
    check("    and having nobody at all is stated outright",
      /No owner found/.test(page),
      "an empty cell reads as not-looked-up");
    check("    the column is driven by the data, not by a check id",
      /hasOwner: items\.some\(\(i: any\) => "owner" in i\)/.test(page),
      "any check that starts returning an owner should get the column");
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

  // ── the Activity table, resized by the same mechanism ───────────────
  //
  // The widget table got draggable columns first. The Activity table is wider,
  // holds longer strings, and had two Tailwind widths hard-coded onto two of
  // its seven headers, so it got the same treatment rather than a second
  // mechanism.
  //
  // Its one complication is that Details carries `hidden lg:table-cell` in both
  // the header and the body: below that breakpoint the table genuinely has six
  // columns, and a seven-entry colgroup over it would shift every width one
  // column across without throwing.
  {
    const page = fs.readFileSync("./src/pages/ActivityPage.tsx", "utf8");
    const { activityColumns, activityWidths, activityLayoutId } = await import("./src/lib/activityColumns");

    check("the Activity columns are data, not hand-written headers",
      /columns\.map\(\(c, i\) => \(/.test(page) && !/uppercase tracking-wider w-32/.test(page),
      "w-32 and w-52 were baked onto two of the seven headers");
    check("  widths come from a colgroup",
      /<colgroup>/.test(page));
    check("  and the layout is fixed, so those widths are honoured",
      /tableLayout: "fixed"/.test(page));
    check("  the last column takes the slack",
      /i === columns\.length - 1$/m.test(page) || /i === columns\.length - 1\s/.test(page));

    // The count has to follow the viewport, because the cells do.
    const wide = activityColumns(true), narrow = activityColumns(false);
    // Asserted on the difference rather than on a count, so consolidating
    // columns is a change to make and not a test to edit. Seven cramped ones
    // became five: source folded into the event, and repository and target
    // stacked into one scope cell.
    check("Details is a column only where it is rendered",
      wide.length === narrow.length + 1
        && wide.some(c => c.id === "details") && !narrow.some(c => c.id === "details"),
      { wide: wide.map(c => c.id), narrow: narrow.map(c => c.id) });
    check("  the breakpoint is read, not assumed",
      /matchMedia\("\(min-width: 1024px\)"\)/.test(page),
      "lg: is 1024px; a hard-coded true would mis-size every narrow viewport");
    check("  and the two layouts are remembered separately",
      activityLayoutId(wide) !== activityLayoutId(narrow),
      "one applied to the other is a layout for columns that are not there");
    check("  When is last in both, so it absorbs the slack",
      wide[wide.length - 1].id === "when" && narrow[narrow.length - 1].id === "when");
    check("  and every column has a starting width",
      wide.every(c => activityWidths(wide)[c.id] > 0));

    // Fixed layout means a cell does not shrink to fit: without overflow
    // hidden a long value draws straight over the column beside it, which is
    // what dragging a column narrow revealed.
    // Bounded forwards. renderRow is defined after paginatedEntries, so
    // slicing between them the other way round produced an empty string and
    // two assertions that passed by having nothing to look at.
    const rowStart = page.indexOf("const renderRow =");
    const body = page.slice(rowStart, page.indexOf("return (", rowStart + 20000));
    const cells = body.match(/<td className="[^"]*"/g) ?? [];
    const clipping = cells.filter(c => /overflow-hidden/.test(c));
    check("every activity cell clips rather than overlapping its neighbour",
      clipping.length >= cells.length - 1,
      { cells: cells.length, clipping: clipping.length });
    check("  and the long values ellipsize with the full text on hover",
      /truncate/.test(body) && /title=\{entry\.repo\}/.test(body)
        && /title=\{entry\.target\}/.test(body));
    // The action chip is `shrink-0`, so it cannot be squeezed. What stops it
    // pushing its neighbours out of the cell is the container wrapping instead.
    check("  and the badges wrap rather than pushing out of the cell",
      /flex flex-wrap items-center gap-1\.5/.test(body),
      "a row of shrink-0 chips in a nowrap container overflows the column");

    check("the empty row spans however many columns there are",
      /colSpan=\{columns\.length\}/.test(page),
      "colSpan={7} would under-span at narrow widths");
    check("  and a handle sits on every column but the last",
      /i < columns\.length - 1 && \(/.test(page) && /ColumnResizeHandle/.test(page));
  }

  // ── the Renovate table shows the pull request, not just its repository ──
  //
  // Every row already carried a title, an age and a URL. None of them had a
  // column, so the table listed the same repository name several times over
  // with nothing to tell the rows apart, and the actual detail only appeared
  // once a row was clicked.
  {
    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
    const cols = widgetColumns({ type: "preset", presetId: "renovate-open", hasStatus: false });
    const ids = cols.map(c => c.id);

    check("a Renovate row has a column for the pull request itself",
      ids.includes("pr") && ids.includes("age") && ids.includes("link"), ids);
    check("  and its entity column is named for what it holds",
      cols.find(c => c.id === "entity")!.label === "Repository",
      '"Entity" over repeated repository names reads as a mistake');
    check("  the title and number are both rendered",
      /\{item\.title \|\| "Untitled"\}/.test(page) && /#\{item\.number\}/.test(page));
    check("  age is shown in days",
      /\{item\.ageDays\}d/.test(page),
      "how long nobody has merged it is the finding this widget exists for");
    check("  and old ones are visibly old",
      /item\.ageDays >= 30/.test(page) && /item\.ageDays >= 7/.test(page),
      "a column of identical grey numbers is a column nobody reads");
    check("  the GitHub link opens in a new tab, safely",
      /rel="noreferrer noopener"/.test(page) && /href=\{item\.url\}/.test(page));
    check("  and clicking it does not also open the detail panel",
      /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(page),
      "the row and the link are two gestures in one place");
  }

  // ── public and internal must not look alike ─────────────────────────
  //
  // GitHub reports an internal repository as `private: true` with
  // `visibility: "internal"`. The Repos tab counts the boolean and calls it
  // private; this check reads the string and does not. An enterprise
  // organization full of internal repositories saw "100% private" on one
  // screen and dozens of rows on the other, both correct and contradictory,
  // under a card titled "Public repositories".
  {
    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
    const opts: any = await import("./src/utils/queryOptions");
    const list = opts.QUERY_OPTIONS ?? opts.default ?? [];
    const pub = list.find((o: any) => o.id === "public-repos");

    check("the check is not named for only half of what it finds",
      !!pub && !/^Public repositories$/.test(pub.label), pub?.label);
    check("  and its name says which two things it means",
      !!pub && /public/i.test(pub.label) && /internal/i.test(pub.label), pub?.label);

    const withVis = widgetColumns({ type: "query", hasStatus: false, hasVisibility: true });
    check("a row reporting a visibility gets a column for it",
      withVis.some(c => c.id === "visibility"), withVis.map(c => c.id));
    check("  absent when no row reports one",
      !widgetColumns({ type: "query", hasStatus: false }).some(c => c.id === "visibility"));
    check("  the column is driven by the data, not by a check id",
      /hasVisibility: items\.some\(\(i: any\) => "visibility" in i\)/.test(page));
    check("  the body renders a cell under the same condition",
      /columns\.some\(c => c\.id === "visibility"\) && \(/.test(page),
      "a column without its cell shifts every width one across");
    check("  and public reads differently from internal",
      /item\.visibility === "public"/.test(page) && /fa-globe/.test(page) && /fa-building/.test(page),
      "one pill colour for both would restate the problem the column exists to fix");
  }

// ── the Action column holds more than its label ───────────────────────
//
// Beside the action chip sit up to three badges: "important", "detailed", and
// in the merged view the stream the row belongs to. At the old 210 the chip was
// clipped as soon as two appeared together, which reads as a broken column
// rather than a narrow one, and had to be dragged wider on every visit.
{
  const { activityColumns, activityLayoutId } = await import("./src/lib/activityColumns");

  const single = activityColumns(true, false);
  const mergedCols = activityColumns(true, true);
  // "action" became "event" when source folded into it. Looked up rather than
  // indexed, so consolidating columns again is a change to make, not a test to
  // rewrite.
  const w = (cs: ReturnType<typeof activityColumns>) => cs.find(c => c.id === "event")!.width;

  check("the event column fits its badges", w(single) >= 240, w(single));
  check("  and the merged view, which shows one more badge, is wider still",
    w(mergedCols) > w(single), { single: w(single), merged: w(mergedCols) });

  // Sharing one id meant a width set on either view was applied to both, and
  // the narrower one always won by being the one somebody dragged.
  check("each view remembers its own layout",
    activityLayoutId(single, false) !== activityLayoutId(mergedCols, true),
    [activityLayoutId(single, false), activityLayoutId(mergedCols, true)]);
  check("  and the id still distinguishes the column sets",
    activityLayoutId(activityColumns(false, true), true)
      !== activityLayoutId(activityColumns(true, true), true));
}

// ── the two arrangements of one feed ──────────────────────────────────
//
// The table is the right shape for working: resizable columns, diffs, and the
// undo controls. It is the wrong shape for the question people open this tab
// with, which is "what happened last night", because a table answers that only
// after the reader has done the grouping in their head.
{
  const page = fs.readFileSync("./src/pages/ActivityPage.tsx", "utf8");
  const timeline = fs.readFileSync("./src/components/ActivityTimeline.tsx", "utf8");
  const pulse = fs.readFileSync("./src/components/ActivityPulse.tsx", "utf8");

  check("the feed can be read as a timeline",
    /<ActivityTimeline/.test(page) && /shape === "timeline" \?/.test(page));
  check("  over the same rows the table shows",
    /entries=\{filtered\}/.test(page),
    "a second view over a different set is two answers to one question");
  check("  and the choice survives a reload",
    /localStorage\.setItem\("activity:shape"/.test(page));

  // The detail panel is a modal over the page, not part of the table, so the
  // timeline reaches undo, redo, retry and the diff without reimplementing any
  // of them.
  check("the timeline does not reimplement the writes",
    !/undoMutation|redoMutation|retryMutation/.test(timeline),
    "two implementations of the one thing in this app that writes");
  check("  and opens a row in place",
    /onOpen=\{setSelectedEvent\}/.test(page),
    "switching view to show something visible without switching is a view thrown away");

  // A chart that narrows with the table is the table drawn twice.
  // Asserted on the wiring rather than on the prose: the component is handed
  // the pulse and nothing else, so it cannot narrow with the table even if
  // somebody later wanted it to.
  check("the header charts everything, not the filter",
    /<ActivityPulse pulse=\{pulse\}/.test(page) && !/serverQuery/.test(pulse),
    "a backdrop that narrows with the table is the table drawn twice");
  check("  and says when it could not reach the end of its own window",
    /!pulse\.exhausted &&/.test(pulse) && /There is more behind that/.test(pulse),
    "a count of what was read, under the heading of a period, is the lie");

  // Muting every stream leaves an empty chart, which is a view of nothing.
  check("the legend cannot hide every stream at once",
    /next\.size < STREAMS\.length - 1/.test(pulse));

  // Stacking answers composition and was being read as comparison: with GitHub
  // at 132 and AWS at 2, the AWS band begins at 132 and its top sits at 134, so
  // AWS looked as tall as GitHub and App on top looked tallest of all on 13.
  check("comparing draws every stream from the baseline",
    /L\$\{\(\(buckets\.length - 1\) \* step\)\.toFixed\(1\)\},\$\{H\}L0,\$\{H\}Z/.test(pulse),
    "a height has to be a value, not a value stacked on other values");
  // Every stream's fill carries an alpha, whatever ink the theme gives it.
  // Pinning the literal rgba() meant a palette change failed a test about
  // overlap being readable.
  check("  translucent, so an overlap shows both",
    (pulse.match(/area:\s*"rgb\(var\(--[a-z-]+\)\s*\/\s*0?\.\d+\)"/g) ?? []).length === 3,
    "an opaque fill hides whichever stream is drawn under it");
  check("  and its scale ignores what is muted",
    /if \(mode === "lines"\) return Math\.max\(1, \.\.\.buckets\.flatMap\(b => STREAMS\.map/.test(pulse),
    "a line that grows because you hid something lied before or lies now");

  check("composing is the other mode, and there is only one chart",
    /\["bars", "ph-chart-bar", "Compose"\]/.test(pulse)
      && /\["lines", "ph-chart-line", "Compare"\]/.test(pulse));
  check("  where a bar is built from the parts that make it up",
    /const h = \(v \/ peak\) \* H;[\s\S]{0,120}?acc \+= h;/.test(pulse));
  check("  and the mode survives a reload",
    /localStorage\.setItem\("activity:pulse-mode"/.test(pulse));

  const stats = fs.readFileSync("./src/components/ActivityStats.tsx", "utf8");
  check("a bar says which day it is, not just its number",
    /titleFor\(hover\)/.test(stats) && /weekday: "short"/.test(stats),
    "an axis tick has room for a day number and not for a day");
  check("  and the hour is on a clock people read",
    /function clockHour/.test(stats) && /h < 12 \? "AM" : "PM"/.test(stats),
    '"14:00" is correct and is not how anybody says it');
}

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
