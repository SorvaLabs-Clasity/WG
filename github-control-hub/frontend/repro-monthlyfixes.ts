/**
 * Monthly fixes: Dependabot security fixes held back and released once a
 * month, in named batches, on their own view of the Vulnerabilities tab.
 *
 * The rules are tested in backend/repro-dependabotmonthly.ts; this keeps the
 * view wired to them, to the permissions that guard them, and to the progress
 * window every other bulk action on the tab uses.
 *
 * Run:  npx tsx repro-monthlyfixes.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const view = fs.readFileSync("src/components/MonthlyBatches.tsx", "utf8");
const page = fs.readFileSync("src/pages/DependencyDashboardPage.tsx", "utf8");
const progress = fs.readFileSync("src/hooks/useBatchedProgress.tsx", "utf8");

console.log("where it is");
check("its own view on the Vulnerabilities tab, for somebody who may read it",
  /\["monthly", "Monthly fixes"\]/.test(page) && /const canMonthly = can\("deps\.dependabot\.read"\)/.test(page)
    && /view === "monthly" && <MonthlyBatches/.test(page));
check("  the old panel at the bottom of Manage is gone", !fs.existsSync("src/components/MonthlyFixesPanel.tsx"));

console.log("\nwhat it offers");
check("it reads the batches only for somebody known to hold the read", /enabled: holds\("deps\.dependabot\.read"\)/.test(view));
check("changes only for somebody who may make them", /const mayChange = can\("deps\.dependabot\.bulk"\)/.test(view));
check("named batches, each with its own day",
  /createBatch\(name, day\)/.test(view) && /The \{ordinal\(d\)\} of each month/.test(view));
check("each batch can be released by hand", /runBatchNow\(b\.id, s\)/.test(view));
check("  and running, deleting, both ask first",
  /open=\{confirm\?\.kind === "run"\}/.test(view) && /open=\{confirm\?\.kind === "delete"\}/.test(view));

console.log("\nwho can be added");
check("a repository whose fix pull requests are off cannot be ticked, and says why",
  /c\.fixesEnabled === false \? "Fix pull requests are off/.test(view) && /disabled=\{!!r\.reason\}/.test(view));
check("  nor one already in another batch", /`In "\$\{other\}"`/.test(view));

console.log("\nthe progress window");
check("adding, taking out and running go through it",
  /runOver\(`Adding/.test(view) && /runOver\(`Taking/.test(view) && /runOver\(`Releasing/.test(view));
check("  which is the tab's own progress dialog, with Stop",
  /<ProgressDialog/.test(progress) && /label: "Stop"/.test(progress));
check("repositories not getting fixes are shown, not only counted", /missedAll\.slice\(0, 8\)\.map/.test(view));

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
