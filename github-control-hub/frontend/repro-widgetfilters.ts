import fs from "node:fs";
import {
  applyWidgetFilters, filterableColumns, valueFor, isActive,
  activeFilterCount, describeFilter, type WidgetFilter,
} from "./src/lib/widgetFilters";
import { widgetColumns } from "./src/lib/widgetColumns";

/**
 * Regression test: per-column filters on a personal widget.
 *
 * The thing that would be worst here is a filter that quietly keeps or drops
 * the wrong rows, because the result still looks like a plausible answer to the
 * check. Second worst is a count that disagrees with the rows underneath it,
 * which is what happens the moment filtering moves out of the one place that
 * produces both.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const rows = [
  { repo: "payments-api", owner: "platform", ownerKind: "team", status: "fail", bypasses: 12, visibility: "public" },
  { repo: "payments-web", owner: "platform", ownerKind: "team", status: "pass", bypasses: 0, visibility: "private" },
  { repo: "billing-core", owner: "finance", ownerKind: "team", status: "fail", bypasses: 3, visibility: "private" },
  { repo: "legacy-tools", status: "fail", bypasses: 1, visibility: "public" },
  { user: "ada", owner: "ada", ownerKind: "admin", status: "pass", bypasses: 0 },
];

(async () => {
  console.log("\nthe subject of a row is one column, whatever field it sits in");
  {
    // The table shows one Entity column over three possible fields, and a
    // filter has to see what the reader sees.
    check("a repository row answers with its repository",
      valueFor(rows[0], "entity") === "payments-api");
    check("  and a user row with its user", valueFor(rows[4], "entity") === "ada");
    check("  while an ordinary column reads straight through",
      valueFor(rows[0], "owner") === "platform");
  }

  console.log("\nnaming repositories keeps only those");
  {
    const f: WidgetFilter[] = [{ column: "entity", values: ["payments"] }];
    const out = applyWidgetFilters(rows, f);
    check("a partial name keeps every row it matches", out.length === 2, out.map(r => r.repo));
    check("  and drops the rest", !out.some(r => r.repo === "billing-core"));
  }

  console.log("\ncase does not have to be remembered");
  {
    const out = applyWidgetFilters(rows, [{ column: "entity", values: ["PAYMENTS-API"] }]);
    check("a name typed in the wrong case still matches", out.length === 1, out.length);
  }

  console.log("\nhiding is the other half of choosing");
  {
    const out = applyWidgetFilters(rows, [
      { column: "entity", mode: "exclude", values: ["payments"] },
    ]);
    check("excluded rows go and the others stay", out.length === 3, out.map(r => r.repo ?? r.user));
  }

  console.log("\na row missing the value is not a match");
  {
    // legacy-tools has no owner. A board narrowed to two owners must not get it
    // back on the grounds that it has none.
    const out = applyWidgetFilters(rows, [{ column: "owner", values: ["platform", "finance"] }]);
    check("absence does not count as a wildcard",
      !out.some(r => r.repo === "legacy-tools"), out.map(r => r.repo ?? r.user));
    check("  and the rows that do match are kept", out.length === 3, out.length);

    // The inverse: excluding two owners keeps the row that has neither.
    const excluded = applyWidgetFilters(rows, [
      { column: "owner", mode: "exclude", values: ["platform", "finance"] },
    ]);
    check("  while excluding those owners keeps the row with none",
      excluded.some(r => r.repo === "legacy-tools"), excluded.map(r => r.repo ?? r.user));
  }

  console.log("\ncolumns combine with AND, values within one with OR");
  {
    // How people describe a board out loud: "my two repositories, only the
    // failing ones".
    const out = applyWidgetFilters(rows, [
      { column: "entity", values: ["payments", "billing"] },
      { column: "status", values: ["fail"] },
    ]);
    check("both conditions have to hold", out.length === 2, out.map(r => r.repo));
    check("  and either value satisfies the one that offers a choice",
      out.map(r => r.repo).sort().join() === "billing-core,payments-api",
      out.map(r => r.repo));
  }

  console.log("\na count is a range, not a word to spell");
  {
    check("a lower bound keeps what is at or above it",
      applyWidgetFilters(rows, [{ column: "bypasses", min: 3 }]).length === 2);
    check("  an upper bound keeps what is at or below it",
      applyWidgetFilters(rows, [{ column: "bypasses", max: 1 }]).length === 3);
    check("  and both together are inclusive at each end",
      applyWidgetFilters(rows, [{ column: "bypasses", min: 1, max: 3 }]).length === 2);

    // Bounds have no sensible inverted form, so mode is ignored rather than
    // silently producing a range with a hole in it.
    check("  a range ignores exclude rather than inverting itself",
      applyWidgetFilters(rows, [{ column: "bypasses", min: 3, mode: "exclude" }]).length === 2);
  }

  console.log("\nan empty filter narrows nothing");
  {
    check("no values means no narrowing",
      applyWidgetFilters(rows, [{ column: "entity", values: [] }]).length === rows.length);
    check("  blank text is not a value", !isActive({ column: "entity", values: ["  "] })
      || applyWidgetFilters(rows, [{ column: "entity", values: ["  "] }]).length === rows.length);
    check("  and no filters at all returns the same list",
      applyWidgetFilters(rows, []) === rows);
  }

  console.log("\nwhat can be filtered comes from the rows, not from a list of checks");
  {
    const cols = widgetColumns({
      type: "query", presetId: undefined,
      hasStatus: true, hasOwner: true, hasVisibility: true, hasBypasses: true,
    });
    const available = filterableColumns(cols, rows);
    const ids = available.map(c => c.id);

    check("the entity column is offered", ids.includes("entity"), ids);
    check("  so is owner", ids.includes("owner"), ids);
    // Prose assembled per row. A filter on it would be a text search wearing a
    // filter's clothes, and the alarm on the same check already matches text.
    check("  details is not", !ids.includes("details"), ids);
    check("  nor is the row number", !ids.includes("index"), ids);

    const status = available.find(c => c.id === "status");
    check("a small fixed set becomes a list to pick from", status?.kind === "enum", status);
    check("  offering exactly the values present",
      status?.options.join() === "fail,pass", status?.options);

    const bypasses = available.find(c => c.id === "bypasses");
    check("a count becomes a range", bypasses?.kind === "number", bypasses);
  }

  console.log("\na column of names is typed into, however few names there are today");
  {
    /**
     * Owner rendered as a row of tick boxes and no input at all, because the
     * three rows here carry two owners and "few distinct values" was read as
     * "a fixed set to pick from".
     *
     * The two are not the same thing. Status has a *closed* vocabulary: the
     * app defines it, and fail and pass are all there will ever be. Owner has
     * an open one that merely happens to be short in today's rows, and one new
     * team makes the boxes wrong. A filter is also a thing people save and
     * reuse, so a control built from the values present the day it was made is
     * a control that quietly stops offering the answer later.
     *
     * And the failure was total rather than partial: with no text field, a
     * team absent from the current rows could not be filtered for at all.
     */
    const cols = widgetColumns({
      type: "query", hasStatus: true, hasOwner: true, hasVisibility: true, hasBypasses: true,
    });
    const available = filterableColumns(cols, rows);

    const owner = available.find(c => c.id === "owner");
    check("owner is typed into, not picked from", owner?.kind === "text", owner);

    const entity = available.find(c => c.id === "entity");
    check("  so is the entity, which holds repository names", entity?.kind === "text", entity);

    // The closed vocabularies keep their lists: nobody should have to spell
    // "fail" correctly to filter on it.
    check("  while status still offers its values",
      available.find(c => c.id === "status")?.kind === "enum");
    check("  and so does visibility",
      available.find(c => c.id === "visibility")?.kind === "enum");
    // Counts are still ranges.
    check("  and a count is still a range",
      available.find(c => c.id === "bypasses")?.kind === "number");
  }

  console.log("\nan enum with nothing in it is not offered at all");
  {
    // A dropdown of no choices reads as a broken control rather than as an
    // organization with nothing in it.
    const cols = widgetColumns({
      type: "query", hasStatus: true, hasOwner: false, hasVisibility: true, hasBypasses: false,
    });
    const empty = filterableColumns(cols, [{ repo: "a" }, { repo: "b" }]);
    check("no values means no control", !empty.some(c => c.id === "status" || c.id === "visibility"),
      empty.map(c => c.id));
  }

  console.log("\na filter says what it does, in the table's own words");
  {
    check("one value reads as itself",
      describeFilter({ column: "owner", values: ["platform"] }, "Owner") === "Owner is platform");
    check("  excluding says so",
      describeFilter({ column: "owner", mode: "exclude", values: ["platform"] }, "Owner")
        === "Owner not platform");
    check("  a range reads as a range",
      describeFilter({ column: "bypasses", min: 1, max: 5 }, "Bypasses") === "Bypasses 1–5");
    check("  and the count is of filters that actually narrow",
      activeFilterCount([{ column: "a", values: [] }, { column: "b", values: ["x"] }]) === 1);
  }

  console.log("\nthe count and the rows are produced in one place");
  {
    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");

    // A card reading 112 that opens onto four rows is the bug this placement
    // prevents. Both numbers have to come out of the same function.
    check("filtering happens inside the data hook",
      /const shown = useMemo\(\s*\n?\s*\(\) => applyWidgetFilters\(items, config\.filters\)/.test(page),
      "if this moves into the table, the card's number stops agreeing with it");
    check("  and the count follows the filtered rows",
      /count: filtering \? shown\.length/.test(page));

    // A trimmed snapshot holds some rows and the true count of all of them.
    // Filtering that compares against rows that are missing.
    check("a filtered widget will not read a trimmed snapshot",
      /\(opts\?\.needAllRows \|\| filtering\) && snapshot\.trimmed/.test(page),
      "the rows that were cut might be the ones the filter would have kept");

    // The editor has to offer values the current filter has hidden, or a
    // narrowed board can never be widened again.
    check("the unfiltered rows are still reachable", /allItems: items,/.test(page));

    const editor = fs.readFileSync(
      "./src/components/WidgetFilterEditor.tsx", "utf8");
    check("  and the editor reads those, not the narrowed ones",
      /allItems: unfiltered/.test(editor),
      "building the choices from filtered rows makes a filter impossible to undo");
    check("  with the preview using the same function as the board",
      /applyWidgetFilters\(unfiltered, draft\)/.test(editor)
        && !/require\(/.test(editor));
  }

  console.log("\nthe personal board says when a filter is deciding the number");
  {
    const card = fs.readFileSync("./src/components/PersonalCard.tsx", "utf8");
    // Otherwise this card and the Overview show two different numbers for the
    // same check and neither says why.
    // Anchored on the figure being rendered, not on the sentence around it:
    // the card was redesigned to lead with the count and the wording moved.
    check("the unfiltered figure is shown beside the filtered one",
      /\{unfiltered\.toLocaleString\(\)\}/.test(card) && /filtered &&/.test(card));
    check("  and an empty result distinguishes its two causes",
      /Nothing matches your filters/.test(card) && /Nothing found/.test(card));

    const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");
    check("  as does the detail view somebody opens from it",
      /This card is narrowed by its own filters/.test(page));
  }

  console.log("\na dialog opened from a card actually appears");
  {
    const board = fs.readFileSync("./src/components/PersonalBoard.tsx", "utf8");

    // The modals sat only under the grid, below an early return for the detail
    // view. Pressing Add alarm from inside a card set the state and mounted
    // nothing; pressing Edit afterwards left the detail view and mounted both
    // at once, so the alarm dialog appeared on the wrong click with the edit
    // form waiting behind it.
    const declared = board.indexOf("const modals = (");
    check("the dialogs are declared once", declared > 0);
    const detailReturn = board.indexOf("if (opened) {");
    const uses = [...board.matchAll(/\{modals\}/g)].map(m => m.index!);
    check("  and rendered from the detail view as well as the grid",
      uses.length === 2 && uses.some(i => i > detailReturn) && detailReturn > declared,
      { uses, detailReturn, declared });
    check("    with no second copy left behind",
      (board.match(/<WidgetFilterEditor/g) ?? []).length === 1
        && (board.match(/<AlarmModal/g) ?? []).length === 1);
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
