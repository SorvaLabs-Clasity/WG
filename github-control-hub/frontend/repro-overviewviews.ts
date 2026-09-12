/**
 * Searching the dashboard, and reading it two ways.
 *
 * Two additions to the Overview tab: a search box over the checks, and a switch
 * between cards and a dense list. Both are view-level, and the traps are the
 * ones view-level features usually have.
 *
 * The first is that a filtered list looks exactly like a shorter list. Somebody
 * who types a search, gets three cards, and forgets the box is filled concludes
 * a check was deleted. So the count is stated whenever a search is active, and
 * an empty result says why it is empty rather than rendering nothing.
 *
 * The second is subtler. The dashboard's ordering, its headline count and its
 * worst-level are all derived from what the *rendered* checks report back. A
 * list view that rendered rows without running the same data path would leave
 * the page saying "0 of 0 checks" above twenty visible rows, so the row
 * component shares the card's data path exactly.
 *
 * Run:  npx tsx repro-overviewviews.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import { widgetColumns, layoutId } from "./src/lib/widgetColumns";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
const code = page.split("\n")
  .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");

(async () => {
  // ── search ──────────────────────────────────────────────────────────
  {
    // The visible label moved out of the placeholder and into a small-cap
    // "Find" beside the field, so the accessible name is what to assert: it is
    // the part that has to survive any amount of redesigning.
    check("the checks can be searched", /aria-label="Search checks"/.test(code));
    check("  by title and by what the check asks",
      /\$\{w\.title\} \$\{label\} \$\{w\.queryParam \?\? ""\}/.test(code),
      'a card named "Prod repos" must be findable by "protection"');
    check("  matched case-insensitively",
      /\.toLowerCase\(\)\.includes\(q\)/.test(code));
    check("  the box can be cleared without selecting the text",
      /aria-label="Clear search"/.test(code));
    check("  a filtered list says how much it is hiding",
      /\{visible\.length\} of \{widgets\.length\}/.test(code),
      "a short list that looks whole is how somebody concludes a check was deleted");
    check("  and matching nothing explains itself",
      /No checks match that/.test(code) && /Clear the search/.test(code),
      "an empty grid reads as a broken dashboard");
    check("  the toolbar stays out of the way on a small dashboard",
      /widgets\.length > 2 && \(/.test(code),
      "a filter over two cards is furniture");
  }

  // ── the two views ───────────────────────────────────────────────────
  {
    check("there are two views, and the switch is a real toggle",
      /aria-pressed=\{view === v\}/.test(code));
    check("  the choice is remembered per browser",
      /localStorage\.setItem\("overview:view"/.test(code));
    check("  and a browser that refuses storage still switches view",
      /catch \{ \/\* the view still changes \*\/ \}/.test(page),
      "a preference that cannot be saved is not a reason to fail to change it");

    check("both views render the same filtered, ordered list",
      (code.match(/\{visible\.map\(\(w, i\) => \(/g) ?? []).length === 2,
      "switching view must never reorder or drop a check");
  }

  // ── the row shares the card's data path ─────────────────────────────
  {
    check("the row component exists alongside the card",
      /function CheckRow\(\{/.test(code));

    // Sliced rather than matched within a character window: the window has to
    // be guessed, and a guess that is slightly short passes an assertion by
    // failing to reach the thing it is checking for.
    const rowStart = code.indexOf("function CheckRow({");
    const row = code.slice(rowStart, code.indexOf("function CheckCard({", rowStart));

    check("  it runs the same data hook",
      /useWidgetData\(config, \{ live \}\)/.test(row));
    check("  reaches the same verdict",
      /verdictFor\(items, total, config\)/.test(row));
    check("  and reports it, so the page's own counts still add up",
      /onReport\(config\.id, verdict\)/.test(row),
      'without this the header would read "0 of 0 checks" above twenty rows');

    // The list view exists for the dashboard a card grid cannot show at once,
    // so it must survive a check that could not be read.
    check("a check that cannot be read still gets a row",
      /unreadable/.test(row),
      "a row that renders nothing is indistinguishable from a check that vanished");
    check("  and its share is not drawn from a number it does not have",
      /!isLoading && !broken && \(/.test(row));
    check("  nor is a percentage invented where there is no denominator",
      /pct === null \? \(/.test(row),
      "share is null for a check with nothing to divide by");
  }

  // ── the widget form asks for what the query actually takes ──────────
  //
  // "Repos exposed through vulnerable package(s)" asked for a branch name and
  // put a git-branch icon on every package you typed. The tag input was built
  // for the branch queries and the copy was hard-coded there, so every query
  // added afterwards inherited a branch form. The state was called
  // `branchTags`, which is how it stayed unnoticed.
  {
    const src = (f: string) => fs.readFileSync(`./src/${f}`, "utf8");
    const modal = src("pages/AnalyticsPage.tsx");
    const scanner = src("components/ScannerModal.tsx");
    const options = src("utils/queryOptions.ts");
    const { QUERY_OPTIONS, paramNoun } = await import("./src/utils/queryOptions");

    // Scoped to the tag input, since a branch *query* legitimately shows a
    // branch icon in the picker.
    const tagInputs = [...modal.matchAll(/<TagInput[\s\S]{0,900}?\/>/g),
                       ...scanner.matchAll(/<TagInput[\s\S]{0,900}?\/>/g)].map(m => m[0]);
    check("every query's tag input exists to check", tagInputs.length >= 3, String(tagInputs.length));

    const queryTagInputs = tagInputs.filter(t => t.includes("selectedQuery"));
    check("  and the ones driven by a query hard-code neither icon nor prompt",
      queryTagInputs.length >= 3 &&
      queryTagInputs.every(t => !/icon="/.test(t) && !/placeholder="/.test(t)),
      "a literal here is a promise that every future query is about branches");

    check("  the icon comes from the query",
      queryTagInputs.every(t => /icon=\{selectedQuery\.paramIcon/.test(t)));
    check("  and the prompt from its own label",
      queryTagInputs.every(t => /placeholder=\{`Type \$\{paramNoun|placeholder=\{`Enter \$\{paramNoun/.test(t)));

    // The errors beside the field said "branch name" too.
    check("no leftover copy calls a package a branch",
      !/the branch name before saving|At least one branch name is required/.test(modal),
      "the message you get for typing a package name wrong said 'branch'");

    // Every tag query declares what its tags are, or the fallback silently
    // puts the query's own icon on them.
    for (const q of QUERY_OPTIONS.filter(o => o.useTagInput)) {
      check(`  ${q.id} says what its tags are`, !!q.paramIcon && !!q.paramLabel, q.id);
    }
    check("the package query asks for packages",
      QUERY_OPTIONS.find(q => q.id === "repos-dependent-on")?.paramIcon === "ph-package");
    check("  and reads as a noun in a sentence",
      paramNoun("Package name(s)") === "package name" && paramNoun("Branch Name(s)") === "branch name",
      paramNoun("Package name(s)"));
    check("  with the list typed, so an optional field cannot be inferred away",
      /QUERY_OPTIONS: QueryOption\[\]/.test(options));
  }

  // ── bypass ranking moved from a preset to an insight query ──────────
  //
  // Both forms always asked the backend the same question, so this is a change
  // to which door the form offers rather than to what the check does. The trap
  // is entirely in the widgets that already exist: they are stored as presets,
  // and the alarm catalogue keys its "bypasses in total" metric off that stored
  // presetId. Rewriting them to the query form would silently invalidate any
  // alarm someone had set, so they are left alone and only the form changes.
  {
    const { QUERY_OPTIONS } = await import("./src/utils/queryOptions");
    const bypass = QUERY_OPTIONS.find(q => q.id === "protection-bypasses-ranking");
    check("bypass ranking is offered as an insight query",
      !!bypass, QUERY_OPTIONS.map(q => q.id));
    check("  which takes no parameter, so the form asks for nothing",
      bypass?.requiresParam === false);
    check("  and counts repositories, so the card's share has a denominator",
      bypass?.entity === "repository", bypass?.entity);

    const presets = fs.readFileSync("./src/lib/widgetPresets.ts", "utf8");
    check("the preset form no longer offers it",
      /CREATABLE_PRESETS = \[[^\]]*\]/.test(presets)
      && !/CREATABLE_PRESETS = \[[^\]]*"bypasses"/.test(presets),
      presets.match(/CREATABLE_PRESETS = \[[^\]]*\]/)?.[0]);
    check("  the dropdown is built from that list, not from every label",
      /presetOptions\(initialData\?\.presetId\)\.map\(id => \(/.test(code),
      "iterating PRESET_LABELS would put it back");

    // A <select> whose value is not among its options shows the first one
    // instead. Editing the title of an existing bypass widget would then submit
    // whatever the browser had settled on.
    const { presetOptions } = await import("./src/lib/widgetPresets");
    check("  a new widget is offered only the creatable presets",
      !presetOptions(undefined).includes("bypasses"), presetOptions(undefined));
    check("  but editing an old one can still see what it is set to",
      presetOptions("bypasses").includes("bypasses"),
      "the form would claim it was a Dependabot ranking, and saving would make that true");
    check("    without duplicating a preset that is already there",
      presetOptions("dependabot").filter(x => x === "dependabot").length === 1,
      presetOptions("dependabot"));

    // Everything below is what an existing widget still depends on.
    check("a widget stored as the old preset is still named",
      /"bypasses": "Protection Rule Bypasses"/.test(presets),
      "dropping the label leaves old widgets blank in search and the row view");
    check("  and still renders its own columns",
      widgetColumns({ type: "preset", presetId: "bypasses", hasStatus: false })
        .some(c => c.id === "bypasses"));
    check("  under the column set it was saved with",
      layoutId("w", widgetColumns({ type: "preset", presetId: "bypasses", hasStatus: false }))
        === "widget:w:index,entity,bypasses,reason",
      "changing the ids would discard the widths someone dragged");

    // The new form has to reach the same place.
    const q = widgetColumns({ type: "query", hasStatus: false });
    const qb = widgetColumns({ type: "query", hasStatus: false, hasBypasses: true });
    check("the query form gets a column for the count",
      qb.length === q.length + 1 && qb.some(c => c.id === "bypasses"), qb.map(c => c.id));
    check("  placed before Details, which already carries the reason",
      qb.findIndex(c => c.id === "bypasses") < qb.findIndex(c => c.id === "details"));
    check("  and absent when no row carries one",
      !q.some(c => c.id === "bypasses"));
    check("  the body renders a cell under exactly the same condition",
      /\{config\.type === "query" && columns\.some\(c => c\.id === "bypasses"\) && \(/.test(page),
      "a column without its cell shifts every width one across");
    check("  driven by the data, not by a check id",
      /hasBypasses: items\.some\(\(i: any\) => typeof i\.bypasses === "number"\)/.test(code));
    check("both forms describe a row the same way",
      /if \(typeof item\?\.bypasses === "number"\) return `\$\{item\.bypasses\} bypasses`/.test(code),
      "keying off the config left the query form showing a truncated sentence");
  }

  // ── the display format control ──────────────────────────────────────
  //
  // It chose between a big number and a table back when those were different
  // renderings. The card carries both now, so the control changed nothing you
  // could see. The stored field stays: the API requires one, and every widget
  // on disk has one.
  {
    check("the form no longer asks for a display format",
      !/Display Format/.test(page) && !/setDisplayType/.test(code),
      "a control that changes nothing is worse than no control");
    check("  and nothing branches on it",
      !/displayType === "metric"|displayType === "table"/.test(code));
    check("  but a created widget still carries the field",
      (code.match(/\bdisplayType,/g) ?? []).length === 2,
      "the API rejects a widget without one");
    check("  and editing an existing widget preserves the value it had",
      /initialData\?\.displayType \|\|/.test(code),
      "defaulting unconditionally would rewrite every widget it touched");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
