/**
 * Re-triggering Dependabot without writing to anybody's repository.
 *
 * The documented trigger, a grouped-security-updates dependabot.yml, has to
 * reach the default branch, and on an organization with branch protection that
 * is a pull request and an approval per repository before a single fix arrives.
 * Switching security updates off and immediately on again needs none of that:
 * two calls, no file, no review.
 *
 * GitHub does not document it as a re-trigger, and it may do nothing. That is
 * an acceptable thing to try precisely because it is free. What is not
 * acceptable is the failure mode: this turns a security feature OFF as its
 * first step, and a run that dies in between leaves repositories unprotected
 * and nobody told. So the property under test is not "did it re-trigger",
 * which cannot be asserted from here, but "it can never leave a repository
 * switched off and quiet about it".
 */
import fs from "fs";
import path from "path";
import { runDependabotBulk } from "./src/services/dependabotBulk";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** An octokit that records what was asked of it, and can be told to refuse. */
function fakeOctokit(refuse: (call: string, repo: string) => any = () => null) {
  const calls: string[] = [];
  const make = (name: string) => async ({ repo }: any) => {
    calls.push(`${name}:${repo}`);
    const err = refuse(name, repo);
    if (err) throw err;
    return {};
  };
  return {
    calls,
    rest: {
      repos: {
        enableVulnerabilityAlerts: make("alerts-on"),
        disableVulnerabilityAlerts: make("alerts-off"),
        enableAutomatedSecurityFixes: make("fixes-on"),
        disableAutomatedSecurityFixes: make("fixes-off"),
      },
    },
  };
}

const permanent = () => Object.assign(new Error("Resource not accessible by integration"), { status: 403 });

(async () => {
  console.log("re-triggering is off and then on, in that order");
  {
    const octokit = fakeOctokit();
    const summary = await runDependabotBulk(octokit as any, "Org", ["api"], "retrigger");
    check("both calls are made", octokit.calls.length === 2, octokit.calls);
    check("  off first, then on",
      octokit.calls[0] === "fixes-off:api" && octokit.calls[1] === "fixes-on:api", octokit.calls);
    check("  and the repository is reported as changed", summary.results[0]?.ok === true);
  }

  console.log("\nit can never leave a repository switched off and say nothing");
  {
    // The dangerous case: the switch went off, and putting it back failed for
    // a reason waiting will not fix. The repository is now less protected than
    // before somebody pressed a button to improve it.
    const octokit = fakeOctokit((call) => (call === "fixes-on" ? permanent() : null));
    const summary = await runDependabotBulk(octokit as any, "Org", ["api"], "retrigger");

    check("the repository is reported as failed", summary.results[0]?.ok === false);
    check("  and its error says it is now off",
      /off|disabled/i.test(String(summary.results[0]?.error)), summary.results[0]?.error);
    check("  and the summary counts it as left off",
      summary.leftOff === 1, summary);
    check("  naming the repository, because a count cannot be acted on",
      Array.isArray(summary.leftOffRepos) && summary.leftOffRepos[0] === "api", summary);
  }

  console.log("\nputting it back is tried harder than turning it off was");
  {
    // A transient failure on the way back must not be accepted the way a
    // transient failure on the way out would be: the two directions have very
    // different consequences.
    let attempts = 0;
    const octokit = fakeOctokit((call) => {
      if (call !== "fixes-on") return null;
      attempts++;
      return attempts < 3 ? Object.assign(new Error("secondary rate limit"), { status: 403 }) : null;
    });
    const summary = await runDependabotBulk(octokit as any, "Org", ["api"], "retrigger");
    check("a transient refusal is retried until it sticks", attempts >= 3, attempts);
    check("  and the repository ends up on", summary.results[0]?.ok === true);
    check("  with nothing left off", summary.leftOff === 0);
  }

  console.log("\nthe existing actions are untouched by any of this");
  {
    const octokit = fakeOctokit();
    await runDependabotBulk(octokit as any, "Org", ["api"], "fixes-on");
    check("fixes-on still turns alerts on first",
      octokit.calls[0] === "alerts-on:api" && octokit.calls[1] === "fixes-on:api", octokit.calls);
  }

  console.log("\nwhat the screen says before it is pressed");
  {
    const ui = fs.readFileSync(
      path.join(__dirname, "..", "frontend", "src", "components", "DependabotManager.tsx"), "utf8");
    // Somebody must know this switches a security feature off for a moment
    // before they press it, not after reading a failure.
    check("the button says security updates go off briefly", /briefly off|off for a moment|switched off/i.test(ui));
    // And that it may simply not work, because GitHub does not promise it does.
    check("  and that GitHub does not promise this works", /not document|undocumented/i.test(ui));
  }

  console.log("\na protected branch is explained, not just refused");
  {
    const rollout = fs.readFileSync(path.join(__dirname, "src/services/dependabotRollout.ts"), "utf8");
    // The whole reason the re-trigger exists: committing to a protected
    // default branch is refused, and "422" on its own tells nobody why.
    check("the commit path names branch protection when it is refused",
      /protected/i.test(rollout));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
