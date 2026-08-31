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

/** Files that reach GitHub, by the shapes the client is actually called with. */
function filesCallingGitHub(): string[] {
  const found: string[] = [];
  for (const file of walk(ROOT)) {
    const rel = relative(ROOT, file);
    const body = readFileSync(file, "utf8");
    const spends = /\brest\.[a-zA-Z]+\.[a-zA-Z]+\s*\(/.test(body)
      || /\boctokit\.request\s*\(/.test(body)
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
