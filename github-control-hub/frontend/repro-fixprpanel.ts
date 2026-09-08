/**
 * Seeing the open Dependabot pull requests without leaving the tab.
 *
 * The card said "4/18 fix PRs" and stopped there, so learning which four meant
 * going to GitHub. They are now behind that number, in the card for the
 * repository they belong to, above the findings they close.
 *
 * "Not just another section at the top of the page" is the requirement, and it
 * is the one thing a reader of this file cannot check by eye later, so it is
 * checked here: the panel has to render inside the repository card, after the
 * card's header and before the vulnerability list, not as a sibling of the
 * page's own banners.
 */
import fs from "node:fs";
import { READINESS, READINESS_ORDER, checkLabel, reviewLabel } from "./src/lib/prReadiness";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

// Relative to the frontend directory, the way every test here is run.
const read = (f: string) => fs.readFileSync(`./${f}`, "utf8");
const page = read("src/pages/DependencyDashboardPage.tsx");
const renovate = read("src/components/RenovatePanel.tsx");

console.log("one vocabulary underneath, even where the labels differ");
{
  /**
   * These two panels no longer show the same labels, and that is deliberate.
   * The Dependabot one lists pull requests and names their readiness; the
   * Renovate one lists updates that may not be pull requests yet and names
   * what to do about them, so "Ready to merge" and "Held back" are its words.
   *
   * What must stay shared is the layer underneath: both read the `readiness`
   * the backend computes, rather than deciding for themselves what counts as
   * ready. That is the value the shared map was protecting, and it survives.
   */
  check("the Dependabot panel reads the shared map",
    /from "\.\.\/lib\/prReadiness"/.test(page));

  check("  and the Renovate panel derives its own labels from the same readiness",
    /readiness === "ready"/.test(renovate) && !/mergeReadiness/.test(renovate),
    "deciding readiness in the browser is what would let the two disagree");

  check("  every state in the shared map still has a label and an explanation",
    READINESS_ORDER.every(s => READINESS[s].label.length > 0 && READINESS[s].hint.length > 0));
}

console.log("\nunknown is a state, shown as one, and never as ready");
{
  // The details come from a batched query that can fail, and a repository with
  // no checks configured returns nothing rather than a pass.
  check("unknown has its own wording", READINESS.unknown.label === "Unknown");
  check("  and is not styled as success", READINESS.unknown.intent !== "good");
  check("  while a check state nobody reported produces no words at all",
    checkLabel(null) === null && checkLabel(undefined) === null);
  check("  as does a review nobody set", reviewLabel(null) === null);
  check("  and a green rollup does say so", checkLabel("SUCCESS") === "checks passed");
}

console.log("\nthe panel is inside the repository card, not another band at the top");
{
  const cardStart = page.indexOf("<RailCard key={repo}");
  // The render condition, not the heading text: the heading's words also
  // appear in a comment earlier in the file, and matching that found a
  // position the panel is not at.
  const panel = page.indexOf("{prsOpen && repoPrs.length > 0 && (");
  const list = page.indexOf('{visible.map(a => <VulnRow');

  check("it renders inside the card", cardStart > 0 && panel > cardStart, { cardStart, panel });

  // Above the findings, because these are what closes them. Below would read
  // as an afterthought to a list somebody has already scrolled past.
  check("  above the findings it resolves", panel < list, { panel, list });

  // The number is where somebody already is when they want to know which four
  // of eighteen are open.
  check("  and it opens from the count itself", /togglePrs\(repo\)/.test(page));
}

console.log("\nnothing here merges anything");
{
  const row = page.slice(page.indexOf("function FixPrRow"), page.indexOf("function VulnRow"));
  check("every row is a link out to GitHub", /<a href=\{pr\.url\}/.test(row));
  check("  opened in a new tab, safely",
    /rel="noopener noreferrer"/.test(row) && /target="_blank"/.test(row));
  // Merging is GitHub's job, where GitHub authorizes the person doing it
  // against the repository. The whole Renovate panel holds the same line.
  check("  and no merge control exists anywhere on the page",
    !/merge\(|mergePr|\.merge\b/.test(page));
}

console.log("\nfacts that did not come back are left blank, not filled in");
{
  const row = page.slice(page.indexOf("function FixPrRow"), page.indexOf("function VulnRow"));

  // A zero here would be a claim: "this pull request changes no files".
  check("the size is shown only when it was read", /pr\.changedFiles !== undefined &&/.test(row));
  check("  the checks only when GitHub reported them", /\{checks &&/.test(row));
  check("  and the review only when one is set", /\{review &&/.test(row));

  // A grouped pull request bumps many packages and names none of them, so its
  // title is shown instead of an invented package name.
  check("  a pull request with no single package falls back to its title",
    /pr\.packageName \? \(/.test(row));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
