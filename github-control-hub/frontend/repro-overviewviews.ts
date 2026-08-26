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
    check("the checks can be searched", /placeholder="Search checks/.test(code));
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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
