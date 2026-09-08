/**
 * Closing every Dependabot pull request on the repositories somebody picked.
 *
 * This is the most destructive button in the app, and not for the reason it
 * looks. Closing is not "dismiss for now": GitHub treats a manual close exactly
 * as it treats the `@dependabot close` command, and *prevents Dependabot from
 * recreating that pull request*. So a bulk close is a bulk suppression of
 * fixes, and it is silent, and it is per pull request rather than per
 * repository, so undoing it means finding and reopening every one.
 *
 * That makes the blast radius the whole test. Three ways this could destroy
 * something nobody asked it to:
 *
 *   - closing on a repository that was not selected
 *   - closing something Dependabot did not open, the config pull requests this
 *     same app raises being the obvious casualty
 *   - closing something already closed, or merged, and reporting it as work
 *
 * Everything else here is ordinary bulk-write care: pacing, per-item failures
 * that do not stop the run, and a held answer that must be dropped afterwards
 * or the screen keeps showing the pull requests it just closed.
 */
import { closeDependabotPrs } from "./src/services/dependabotClose";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const pr = (repo: string, number: number, over: any = {}) =>
  ({ repo, number, title: `Bump thing in ${repo}`, url: `https://gh/${repo}/${number}`, ...over });

/** Records every close it is asked to make. */
function fakeOctokit(refuse: (repo: string, number: number) => any = () => null) {
  const closed: string[] = [];
  return {
    closed,
    rest: {
      pulls: {
        update: async ({ repo, pull_number, state }: any) => {
          const err = refuse(repo, pull_number);
          if (err) throw err;
          if (state !== "closed") throw new Error(`asked for state ${state}`);
          closed.push(`${repo}#${pull_number}`);
          return {};
        },
      },
    },
  };
}

const found = [
  pr("api", 7), pr("api", 8),
  pr("web", 11),
  pr("untouched", 99),
];

(async () => {
  console.log("only the repositories that were selected");
  {
    const octokit = fakeOctokit();
    const summary = await closeDependabotPrs(octokit as any, "Org", ["api", "web"], async () => found);

    check("every pull request on a selected repository is closed",
      octokit.closed.sort().join() === "api#7,api#8,web#11", octokit.closed);

    // The search is organization-wide, so a filter that leaks closes pull
    // requests on repositories nobody chose. There is no undo for that.
    check("  and nothing on a repository that was not",
      !octokit.closed.some(c => c.startsWith("untouched")), octokit.closed);

    check("  counted per repository, because that is what was selected",
      summary.closed === 3 && summary.byRepo.api === 2 && summary.byRepo.web === 1, summary);
  }

  console.log("\nan empty selection closes nothing at all");
  {
    // The one input where a bug is unbounded: a falsy selection read as "all"
    // would close every Dependabot pull request in the organization.
    const octokit = fakeOctokit();
    const summary = await closeDependabotPrs(octokit as any, "Org", [], async () => found);
    check("nothing is closed", octokit.closed.length === 0, octokit.closed);
    check("  and it is not reported as work", summary.closed === 0);
  }

  console.log("\nonly what Dependabot opened");
  {
    /**
     * The search this reads is `author:app/dependabot`, so the filtering is
     * GitHub's. The thing worth pinning is that nothing here widens it: the
     * config pull requests this same app raises are authored by the person who
     * pressed the button, and closing those would undo the rollout while
     * claiming to have tidied up Dependabot.
     */
    const octokit = fakeOctokit();
    let query = "";
    await closeDependabotPrs(octokit as any, "Org", ["api"], async (q: string) => {
      query = q;
      return [pr("api", 7)];
    });
    check("the search names Dependabot as the author", /author:app\/dependabot/.test(query), query);
    check("  and open ones only", /is:open/.test(query), query);
  }

  console.log("\none refusal does not stop the rest");
  {
    // A pull request somebody cannot write to, on one repository out of forty,
    // must not leave the other thirty-nine untouched.
    const octokit = fakeOctokit((repo, n) =>
      repo === "api" && n === 7 ? Object.assign(new Error("Resource not accessible"), { status: 403 }) : null);
    const summary = await closeDependabotPrs(octokit as any, "Org", ["api", "web"], async () => found);

    check("the others are still closed",
      octokit.closed.sort().join() === "api#8,web#11", octokit.closed);
    check("  and the failure is reported against its repository",
      summary.failed === 1 && /api/.test(summary.failures[0].repo), summary.failures);
    check("  naming the pull request, because a count cannot be chased",
      summary.failures[0].number === 7, summary.failures);
  }

  console.log("\na repository with nothing open is not a failure");
  {
    const octokit = fakeOctokit();
    const summary = await closeDependabotPrs(octokit as any, "Org", ["quiet"], async () => []);
    check("nothing closed, nothing failed", summary.closed === 0 && summary.failed === 0, summary);
  }

  console.log("\nthe held search is dropped, so the screen stops showing what it closed");
  {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const svc = fs.readFileSync(path.join(__dirname, "src/services/dependabotClose.ts"), "utf8");

    // fetchDependabotPrs holds its answer for a minute. Without this the tab
    // reports the pull requests it has just closed as open, which reads as the
    // close having failed.
    check("the cache is cleared after closing", /clearDependabotPrCache\(\)/.test(svc));
  }

  console.log("\nwrites are paced, because GitHub refuses a burst of them");
  {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const svc = fs.readFileSync(path.join(__dirname, "src/services/dependabotClose.ts"), "utf8");

    check("there is a gap between writes", /GAP_MS/.test(svc));
    check("  and a secondary limit is waited out rather than reported",
      /parseRateLimit|isSecondaryLimit|withSecondaryRetry/.test(svc));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
