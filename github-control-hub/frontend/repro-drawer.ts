/**
 * Stopping the Vulnerabilities tab from being a stack of bands.
 *
 * Every feature added to that page had become another horizontal band above
 * the findings: a staleness line, an amber summary of repositories without
 * fixes, and the repository management panel, each reasonable on its own. By
 * the third one the thing somebody opened the tab for had been pushed below
 * the fold by controls they were not using.
 *
 * The fix is structural rather than cosmetic, and it is the pattern that was
 * missing from the design system: a task with a beginning and an end gets its
 * own surface over the page instead of a band inside it. The summary and the
 * panel are two halves of one question, "why are fixes not happening and what
 * do I do about it", so they share that surface. The staleness became four
 * words on the row that was already there.
 *
 * This file holds the structure down, because it is the part that quietly
 * regresses: the next feature is always easiest to add as one more band.
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (f: string) => fs.readFileSync(`./${f}`, "utf8");
const page = read("src/pages/DependencyDashboardPage.tsx");
const design = read("src/design/index.tsx");
const manager = read("src/components/DependabotManager.tsx");
const css = read("src/index.css");

/**
 * What sits between the page heading and the page content.
 *
 * Sliced rather than counted by indentation: nested spans inside a multi-line
 * ternary land at the same depth as a top-level band, and counting those made
 * this pass or fail on formatting rather than on structure.
 */
function betweenHeaderAndContent(src: string): string[] {
  const from = src.indexOf("/>", src.indexOf("<PageHeader"));
  const to = src.indexOf("{notice && (");
  return src.slice(from, to).split("\n")
    .filter(l => /^      <[A-Za-z]/.test(l))
    .map(l => l.trim().split(/[\s>]/)[0].replace("<", ""));
}

console.log("the page is a heading, a row, and the findings");
{
  const between = betweenHeaderAndContent(page);

  // Not a count for its own sake: each of these occupies vertical space above
  // the findings, and the findings are why the tab exists. A drawer is fixed
  // and overlays, so it takes none wherever it is written.
  check("one row between the heading and the content, and nothing else",
    between.filter(b => b !== "Drawer").length === 1, between);
  check("  and the drawer is the only other thing there",
    between.filter(b => b === "Drawer").length === 1, between);

  check("  the manager is inside it, not in the page",
    /<Drawer[\s\S]{0,4000}<DependabotManager/.test(page));

  check("  and the drawer overlays rather than pushing",
    /className="fixed inset-0/.test(design.slice(design.indexOf("export function Drawer"))));
}

console.log("\nthe bands it replaced are gone, not merely moved lower");
{
  // The amber summary as its own block. Its content still exists, inside the
  // drawer, where it explains what to select.
  check("no standalone summary band",
    !/mb-4 rounded-xl border border-amber-200/.test(page));

  // The staleness as a paragraph of its own.
  check("  no standalone staleness band", !/Showing the sweep from/.test(page));
  check("  the staleness survives as a few words on the switcher row",
    /swept \{new Date\(age\.computedAt\)/.test(page));

  // The counts still reach somebody: they are the reason to open the drawer.
  check("  and the breakdown still explains which repositories are stuck",
    /Set up correctly, waiting on GitHub/.test(page)
      && /Findings sit under a parent dependency/.test(page));
}

console.log("\na panel that covers the page can always be dismissed");
{
  const drawer = design.slice(design.indexOf("export function Drawer"), design.indexOf("export function Empty"));

  check("Escape closes it", /e\.key === "Escape"/.test(drawer));
  check("  the backdrop closes it", /onClick=\{onClose\}/.test(drawer));
  check("  and it announces itself as a dialog",
    /role="dialog"/.test(drawer) && /aria-modal="true"/.test(drawer));

  // A toggle would render "Hide" underneath the thing it hides.
  check("  the button that opens it never claims to hide it",
    /setManaging\(true\)/.test(page) && !/setManaging\(m => !m\)/.test(page));
}

console.log("\nand it leaves the page as it found it");
{
  const drawer = design.slice(design.indexOf("export function Drawer"), design.indexOf("export function Empty"));

  // Freezing the page stops a scroll over the backdrop moving content the
  // reader cannot see.
  check("the page behind is frozen while it is open",
    /document\.body\.style\.overflow = "hidden"/.test(drawer));

  // Restored to what it was, not cleared: something else may have set it, and
  // clearing would silently undo theirs.
  check("  and its previous value is restored, not cleared",
    /const previous = document\.body\.style\.overflow/.test(drawer)
      && /document\.body\.style\.overflow = previous/.test(drawer));

  check("  the listener is removed with it",
    /removeEventListener\("keydown", onKey\)/.test(drawer));
}

console.log("\nthe panel inside stops carrying chrome the drawer supplies");
{
  // Two titles, two borders and two paddings is what "just put it in a modal"
  // looks like when nothing is taken away.
  check("no card border of its own", !/<section className=\{`\$\{SURFACE\.card\}/.test(manager));
  check("  no heading of its own, since the drawer has one",
    !/Manage Dependabot\n/.test(manager));
  check("  and the drawer supplies the title instead",
    /title="Manage Dependabot"/.test(page));
}

console.log("\nmotion is decoration, and some people have asked for none");
{
  check("the entrance animations are named", /@keyframes slideIn/.test(css));
  check("  and both are dropped under prefers-reduced-motion",
    /prefers-reduced-motion: reduce\)[\s\S]{0,160}drawer-panel[\s\S]{0,80}animation: none/.test(css));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
