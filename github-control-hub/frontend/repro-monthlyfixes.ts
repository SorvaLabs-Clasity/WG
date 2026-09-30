/**
 * The monthly security-fixes panel, on the Vulnerabilities tab.
 *
 * The rules themselves are tested in backend/repro-dependabotmonthly.ts; this
 * keeps the panel wired to them and to the permissions that guard them.
 *
 * Run:  npx tsx repro-monthlyfixes.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failures++;
}

const panel = fs.readFileSync("src/components/MonthlyFixesPanel.tsx", "utf8");
const manager = fs.readFileSync("src/components/DependabotManager.tsx", "utf8");

check("the panel is in the Dependabot manager, fed its ticked repositories",
  /<MonthlyFixesPanel selected=\{\[\.\.\.selected\]\} \/>/.test(manager));
check("it reads the schedule only for somebody known to hold the read",
  /enabled: holds\("deps\.dependabot\.read"\)/.test(panel));
check("and offers changes only to somebody who may make them",
  /const mayChange = can\("deps\.dependabot\.bulk"\)/.test(panel) && /\{mayChange && \(/.test(panel));
check("running now and turning it off both ask first",
  /open=\{confirm === "run"\}/.test(panel) && /open=\{confirm === "off"\}/.test(panel));
check("repositories not getting fixes are shown, not only counted",
  /missed\.length > 0 &&/.test(panel) && /missed\.slice\(0, 8\)\.map/.test(panel));
check("it says a new vulnerability can wait up to a month",
  /can wait up to a month/.test(panel));

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
