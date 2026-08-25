/**
 * Overview cards line up.
 *
 * The grid carried `items-start`, which tells every cell to shrink to its own
 * content. Each card's height then followed whatever it happened to hold — a
 * check naming three repositories stood taller than one naming a single
 * repository, and one with a percentage bar taller than one without — so a row
 * of cards read as ragged rather than as a set.
 *
 * Equal height needs both halves: the row must be allowed to stretch, and the
 * card must fill the cell it is given. Removing `items-start` alone does
 * nothing visible, because the card still sizes to its content inside a taller
 * cell — which is the version of this that looks unfixed.
 *
 * Run:  npx tsx repro-cardheights.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const page = fs.readFileSync("./src/pages/AnalyticsPage.tsx", "utf8");

(async () => {
  // ── the row is allowed to stretch ───────────────────────────────────
  {
    const grid = /<div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5([^"]*)"/.exec(page);
    check("the widget grid exists", !!grid);
    check("  and does not pin cells to their own content height",
      !!grid && !grid[1].includes("items-start"),
      "items-start makes every card as tall as whatever it happens to hold");
  }

  // ── every card the grid can render fills its cell ───────────────────
  //
  // Four, and a miss on any one of them is a single ragged card in an
  // otherwise even row — which reads as a rendering bug rather than a state.
  {
    const card = page.slice(page.indexOf("function CheckCard"));
    const body = card.slice(0, card.indexOf("\nfunction "));

    // Split on the returns rather than pattern-matching the tag: one root
    // carries an `onKeyDown` arrow, and a `[^>]*` tag matcher stops dead at the
    // `=>` inside it. Only the returns that open an element are renders — the
    // others are a useEffect cleanup.
    const roots = body.split(/\n\s*return \(/).slice(1)
      .filter(r => /^\s*</.test(r))
      .map(r => r.slice(0, 900));

    check("every state the card can return was found", roots.length === 4, roots.length);

    const notFilling = roots.filter(head => !/\bh-full\b/.test(head));
    check("  and each of them fills the cell it is given",
      notFilling.length === 0,
      notFilling.map(c => c.replace(/\s+/g, " ").slice(0, 70)));
  }

  // ── the slack goes somewhere deliberate ─────────────────────────────
  {
    check("the main card lays itself out as a column",
      /h-full flex flex-col/.test(page),
      "otherwise the extra height is dead space with nothing claiming it");
    check("  and the name list takes the extra height",
      /border-white\/\[0\.06\] flex-1"/.test(page),
      "so a short card is padded below the list, not between the figure and it");
    check("  while the loading state keeps a floor rather than a fixed height",
      /h-full min-h-\[268px\]/.test(page) && !/p-6 h-\[268px\]/.test(page),
      "a fixed height cannot grow to match a taller neighbour");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
