import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { buildBudgetReport, FEATURE_NOTES } from "./src/services/githubBudgetService";
import { FEATURE_NOTES as NOTES } from "./src/services/githubBudgetService";

/**
 * Regression test: the GitHub requests page describes the app as it is now.
 *
 * The page reports measured counts, so the numbers cannot drift. What can drift
 * is the reference material beside them: a feature renamed in the code and not
 * here shows up as an undescribed row, and a file that stopped calling GitHub
 * leaves an explanation pointing at nothing. Both are invisible on screen.
 */

let failures = 0;
const ok = (claim: string) => console.log(`  PASS  ${claim}`);
const bad = (claim: string, detail: string) => {
  failures++;
  console.log(`  FAIL  ${claim}\n        ${detail}`);
};

const ROOT = join(__dirname, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Files that reach GitHub.
 *
 * Building a client counts, not only issuing a request through one. A route
 * that constructs a client and hands it to a helper is where the label is
 * applied and therefore where the spend is attributed — `repos.ts` and `me.ts`
 * do exactly that, and a detector that only looked for `rest.*` calls declared
 * their entries stale while they were doing the attributing.
 */
function filesCallingGitHub(): string[] {
  const found: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    if (rel === "github/client.ts") continue;   // the factory itself
    const body = readFileSync(file, "utf8");
    const spends = /\brest\.[a-zA-Z]+\.[a-zA-Z]+\s*\(/.test(body)
      || /\boctokit\.request\s*\(/.test(body)
      || /\bcreateOctokit\s*\(/.test(body)
      || /\bgraphql\s*(<[^>]*>)?\s*\(\s*(query|`|GET_|[A-Z_]+_QUERY)/.test(body);
    if (spends) found.push(rel);
  }
  return found.sort();
}

(async () => {
  const report = await buildBudgetReport();

  console.log("\nEvery file that calls GitHub is described by some feature");
  {
    const declared = new Set(Object.values(FEATURE_NOTES).flatMap(n => n.files));
    const actual = filesCallingGitHub();
    const unattributed = actual.filter(f => !declared.has(f));
    if (unattributed.length === 0) {
      ok(`all ${actual.length} calling files appear in the breakdown`);
    } else {
      bad("a file calls GitHub but no feature note claims it",
        `unattributed: ${unattributed.join(", ")}`);
    }
  }

  console.log("\nNo feature note points at a file that stopped calling GitHub");
  {
    const onDisk = new Set(filesCallingGitHub());
    const declared = [...new Set(Object.values(FEATURE_NOTES).flatMap(n => n.files))];
    const phantom = declared.filter(f => !onDisk.has(f));
    if (phantom.length === 0) ok("every named file still makes GitHub requests");
    else bad("a note names a file that no longer calls GitHub", `stale: ${phantom.join(", ")}`);
  }

  console.log("\nEvery label the code passes has an explanation here");
  {
    // A label is a string typed in two places. Renaming one and not the other
    // is silent: the row appears with a count and no description, and looks
    // like a feature nobody bothered to write up.
    const labels = new Set<string>();
    for (const file of walk(ROOT)) {
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/withFeature\(\s*\n?\s*"([^"]+)"/g)) labels.add(m[1]);
      for (const m of body.matchAll(/createOctokit\([^,)]+,\s*"([^"]+)"\)/g)) labels.add(m[1]);
    }
    const undescribed = [...labels].filter(l => !(l in NOTES));
    if (labels.size === 0) bad("no labels found at all", "the scan is looking in the wrong place");
    else if (undescribed.length === 0) ok(`all ${labels.size} labels in the code are described`);
    else bad("a feature label has no explanation", `undescribed: ${undescribed.join(", ")}`);
  }

  console.log("\nEvery client carries a label");
  {
    /**
     * The failure that produced a page of "Unattributed".
     *
     * A client built with no label sends everything it does to the catch-all
     * bucket. Nothing errors, the page still adds up, and the largest row is a
     * word that explains nothing. Five clients in the dependencies routes and
     * the alarm pass were in exactly that state.
     */
    const bare: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === "github/client.ts") continue;
      const body = readFileSync(file, "utf8");
      for (const m of body.matchAll(/\bcreateOctokit\s*\(/g)) {
        // Walk to the matching paren, so `createOctokit(getSystemToken() || x,
        // "Label")` is read as two arguments rather than as one containing a
        // bracket. Counting brackets is the only way to see a top-level comma.
        let depth = 0, i = m.index! + m[0].length - 1, comma = false;
        for (; i < body.length; i++) {
          const ch = body[i];
          if (ch === "(") depth++;
          else if (ch === ")") { depth--; if (depth === 0) break; }
          else if (ch === "," && depth === 1) comma = true;
        }
        if (comma) continue;
        bare.push(`${rel}: ${body.slice(m.index!, i + 1).replace(/\s+/g, " ")}`);
      }
    }
    if (bare.length === 0) ok("no client is built without one");
    else bad("a client is built with no feature label",
      `everything it does lands under Unattributed:\n        ${bare.join("\n        ")}`);
  }

  console.log("\nUsage is measured, not derived");
  {
    // The estimate fields this page used to publish. Their absence is the
    // assertion: an estimate reintroduced beside a measurement would be read in
    // the same voice, which is the confusion this replaced.
    const body = readFileSync(join(ROOT, "services/githubBudgetService.ts"), "utf8");
    const estimating = /perRun|runsPerHour|perHour|worstCase/.test(body);
    if (!estimating) ok("no per-run or per-hour arithmetic remains");
    else bad("the page is estimating again", "found perRun/runsPerHour/perHour/worstCase");

    const shape = Array.isArray(report.usage) && typeof report.totals === "object";
    if (shape) ok("the report carries measured rows and per-bucket totals");
    else bad("the report shape is wrong", JSON.stringify(Object.keys(report)));
  }

  console.log("\nThe page shows one measurement, not two that disagree");
  {
    const panel = readFileSync(
      join(ROOT, "..", "..", "frontend", "src", "components", "GithubBudgetPanel.tsx"), "utf8");

    /**
     * GitHub's used-of-limit and this app's counts measure different periods:
     * GitHub meters over a rolling window that may have opened a minute ago,
     * these bucket by the clock hour. Both are right, and shown as a pair they
     * read as one number contradicting itself, which is what somebody kept
     * having to ask about.
     */
    const leads = /\{\(totals\[l\.bucket\] \?\? 0\)\.toLocaleString\(\)\}/.test(panel);
    if (leads) ok("each allowance leads with the figure its rows add up to");
    else bad("the headline number is not the one the rows sum to",
      "a reader cannot reconcile two figures that were never the same measurement");

    const usesGitHubUsed = /\{l\.used\.toLocaleString\(\)\}/.test(panel);
    if (!usesGitHubUsed) ok("  GitHub's own used-of-limit no longer sits beside them");
    else bad("GitHub's used figure is shown as a count again",
      "it is measured over a different window and will not match");

    /**
     * And headroom is not in the same box as a count.
     *
     * They are different quantities: one is cumulative over a window, the other
     * is a reading of this instant. Side by side they read as one number
     * contradicting itself, and no amount of labelling fixed it across three
     * attempts. Search is the worst case, because its allowance refills every
     * minute and is therefore almost always full while the count beside it is
     * not zero.
     */
    const countBox = panel.slice(
      panel.indexOf("What this app spent"), panel.indexOf("Room left right now"));
    if (!/l\.remaining/.test(countBox)) ok("  headroom is not inside a count box");
    else bad("a count and a headroom figure share a box",
      "eight requests beside \"30 of 30 available\" reads as a bug, however it is labelled");

    // Still shown, as the one thing GitHub knows that this app cannot.
    if (/Room left right now/.test(panel) && /l\.remaining/.test(panel)) {
      ok("  while what is left is still reported, in its own row");
    } else {
      bad("headroom is gone entirely", "how much room is left is the reason to read this page");
    }

    // The sentence that stops a full allowance reading as a contradiction.
    // Whitespace normalised first: the sentence wraps in the source, and a
    // regex over the raw file is really a test of where the line breaks.
    const prose = panel.replace(/\s+/g, " ");
    if (/own clock rather than at the top of the hour/.test(prose)) {
      ok("    and says why a full reading is normal");
    } else {
      bad("nothing explains a full allowance beside a non-zero count",
        "search refills every minute, so full is its usual state");
    }

    // The window has to be named, not implied. "This hour" was read as "the
    // last sixty minutes", which is not what the counters bucket by.
    if (/since the top of the hour/.test(panel)) ok("  and the period is named exactly");
    else bad("the window is described loosely", "\"this hour\" is what was misread");
  }

  console.log("\nAn empty window says it is empty rather than showing zero");
  {
    // A fresh install and a quiet one produce identical numbers and are
    // completely different situations.
    if (typeof report.empty === "boolean") ok("the report distinguishes the two");
    else bad("nothing says whether anything was recorded", String(report.empty));
  }

  console.log("\nReading the page costs one uncharged request");
  {
    const body = readFileSync(join(ROOT, "services/githubBudgetService.ts"), "utf8");
    const other = /rest\.(?!rateLimit)[a-zA-Z]+\.[a-zA-Z]+\s*\(/.test(body);
    if (!other) ok("the only GitHub call it makes is the free rate-limit read");
    else bad("the budget page spends the budget it reports on", "found a non-rateLimit call");

    // And it counts even that, under its own name.
    if (/createOctokit\(token, "Reading this page"\)/.test(body)) {
      ok("  and counts it, under its own name");
    } else {
      bad("the page does not count its own request",
        "a page that hides its own requests is the wrong page to trust");
    }
  }

  console.log(failures === 0 ? "\nAll claims held.\n" : `\n${failures} claim(s) did not hold.\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
