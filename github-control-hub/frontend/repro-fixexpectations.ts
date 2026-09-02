/**
 * "It has over 100 vulns and only created 4 PRs."
 *
 * The re-trigger worked, and the first thing it produced was a number that
 * looked like a failure. It was not: Dependabot raises one pull request per
 * vulnerable package it can bump, and one bump closes every alert against that
 * package. A hundred findings across twenty packages is twenty pull requests at
 * most, and four of twenty is a rollout in progress.
 *
 * Comparing pull requests against findings is comparing two different units,
 * and it makes a working rollout look stalled and a stalled one look fine. So
 * the screen shows the ceiling the pull requests are actually climbing towards.
 *
 * The care here is all in what is excluded. An inflated ceiling is the worse
 * error of the two: it makes a finished repository read as abandoned, and sends
 * somebody to re-trigger something that has nothing left to do.
 */
import { expectedFixPrs } from "./src/lib/fixExpectations";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const alert = (over: Partial<any> = {}): any => ({
  dependency: "lodash", patched_version: "4.17.21",
  relationship: "direct", ecosystem: "npm", ...over,
});

console.log("one pull request per package, not per finding");
{
  // The observed case: many alerts, few packages.
  const many = [
    alert({ dependency: "lodash" }), alert({ dependency: "lodash" }),
    alert({ dependency: "lodash" }), alert({ dependency: "axios" }),
  ];
  check("four findings on two packages expect two pull requests",
    expectedFixPrs(many) === 2, expectedFixPrs(many));

  // Same package, different advisories and different fixed versions, is still
  // one bump. Keying on package-and-version would restore the bug.
  const versions = [
    alert({ dependency: "lodash", patched_version: "4.17.20" }),
    alert({ dependency: "lodash", patched_version: "4.17.21" }),
  ];
  check("  two advisories against one package are one pull request",
    expectedFixPrs(versions) === 1, expectedFixPrs(versions));
}

console.log("\nthings that can never become a pull request are not counted");
{
  check("an alert with no patch raises nothing",
    expectedFixPrs([alert({ patched_version: null })]) === 0);

  check("  nor does a transitive dependency outside npm",
    expectedFixPrs([alert({ relationship: "transitive", ecosystem: "pip" })]) === 0);

  // npm is the documented exception: the lockfile can be bumped directly.
  check("  while a transitive npm dependency still can",
    expectedFixPrs([alert({ relationship: "transitive", ecosystem: "npm" })]) === 1);

  // "unknown" and "inconclusive" are GitHub declining to say, and dropping
  // them would understate the ceiling and make a stalled rollout look finished.
  check("  and an unstated relationship is counted rather than assumed away",
    expectedFixPrs([alert({ relationship: "unknown" })]) === 1);
  check("  as is a missing one",
    expectedFixPrs([alert({ relationship: null })]) === 1);
}

console.log("\nthe placeholder rows are not findings");
{
  // These carry the repository markers, not vulnerabilities, and counting them
  // would give a clean repository a ceiling above zero.
  check("a clean marker expects nothing", expectedFixPrs([alert({ clean: true })]) === 0);
  check("  a disabled marker expects nothing", expectedFixPrs([alert({ disabled: true })]) === 0);
  check("  a scanning marker expects nothing", expectedFixPrs([alert({ scanning: true })]) === 0);
}

console.log("\na grouped repository has a different ceiling entirely");
{
  // Once a dependabot.yml groups security updates, Dependabot stops opening a
  // pull request per package and opens one per manifest carrying every bump.
  // Keeping the per-package ceiling would leave a finished repository reading
  // "2/40" forever, which is the bug this whole screen exists to avoid: a
  // rollout that worked, displayed as one that stalled.
  const many = [
    alert({ dependency: "lodash", manifest_path: "package.json" }),
    alert({ dependency: "axios", manifest_path: "package.json" }),
    alert({ dependency: "moment", manifest_path: "package.json" }),
    alert({ dependency: "flask", manifest_path: "api/requirements.txt", ecosystem: "pip" }),
  ];
  check("four packages in two manifests expect two grouped pull requests",
    expectedFixPrs(many, true) === 2, expectedFixPrs(many, true));
  check("  where ungrouped would have expected four",
    expectedFixPrs(many, false) === 4, expectedFixPrs(many, false));

  // The exclusions still hold: a manifest whose findings can none of them be
  // fixed produces no grouped pull request either.
  const unfixable = [
    alert({ manifest_path: "package.json", patched_version: null }),
    alert({ manifest_path: "api/requirements.txt", ecosystem: "pip" }),
  ];
  check("  and a manifest with nothing fixable is not counted",
    expectedFixPrs(unfixable, true) === 1, expectedFixPrs(unfixable, true));

  // Defaulting to grouped would understate every repository that has no
  // configuration, which is all of them until somebody rolls one out.
  check("  ungrouped is the default", expectedFixPrs(many) === 4);
}

console.log("\nnothing in, nothing expected");
{
  check("an empty repository expects no pull requests", expectedFixPrs([]) === 0);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
