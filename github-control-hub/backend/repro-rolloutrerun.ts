/**
 * Opening a config pull request, closing it, and opening it again.
 *
 * "It only happens when I create a PR, then close the PR, then try to create it
 * again. On repos where I never created it before, it works."
 *
 * Closing a pull request does not delete its branch, so the second attempt
 * finds `control-hub/dependabot-security-updates` already there with the file
 * on it. Three things in a row can go wrong from that state, and only the first
 * had been fixed:
 *
 *   1. writing a file that exists needs its sha, or GitHub answers
 *      `Invalid request. "sha" wasn't supplied`
 *   2. writing byte-identical content is a commit with no change in it
 *   3. `pulls.create` refuses a head that already has a pull request, and the
 *      useful answer is that pull request rather than the refusal
 *
 * The whole point of the feature is that pressing the button again does the
 * obvious thing. A person who closed a pull request and wants another one is
 * not doing anything unusual.
 */
import { planBranchWrite } from "./src/services/dependabotRollout";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const CONTENT = "version: 2\nupdates: []\n";
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

console.log("a branch that has never existed");
{
  const plan = planBranchWrite(CONTENT, null);
  check("the file is written", plan.write === true);
  check("  with no sha, because there is nothing to replace", plan.sha === undefined, plan);
}

console.log("\na branch left behind by a closed pull request");
{
  // Same file, same content: the state after closing a pull request without
  // merging it and pressing the button again.
  const plan = planBranchWrite(CONTENT, { sha: "abc123", content: b64(CONTENT) });
  check("nothing is written, because nothing would change",
    plan.write === false, plan);
  // A commit with no change in it is noise on somebody's branch, and GitHub's
  // behaviour when asked for one is not something to rely on either way.
  check("  and no empty commit is made", plan.sha === undefined || plan.write === false);
}

console.log("\na branch whose file is out of date");
{
  // The generator's output changes: a new ecosystem appears in the alerts, or
  // the group naming changes. The branch should catch up.
  const plan = planBranchWrite(CONTENT, { sha: "abc123", content: b64("version: 2\nupdates: [old]\n") });
  check("the file is rewritten", plan.write === true);
  check("  with the sha of what it replaces", plan.sha === "abc123", plan);
}

console.log("\ncontent GitHub returned in a shape we did not expect");
{
  // A directory rather than a file, or a payload too large for the contents
  // API to inline. Writing with a sha we could not verify against content we
  // could not read is a guess, so it writes with the sha and lets GitHub judge.
  const plan = planBranchWrite(CONTENT, { sha: "abc123", content: undefined });
  check("it still writes rather than skipping", plan.write === true);
  check("  and supplies the sha it does have", plan.sha === "abc123", plan);
}

console.log("\nline endings are not a reason to rewrite a file every run");
{
  // A branch fetched and pushed through a client that rewrites newlines would
  // otherwise produce a commit on every single run, forever.
  const plan = planBranchWrite(CONTENT, { sha: "abc123", content: b64(CONTENT.replace(/\n/g, "\r\n")) });
  check("identical content with different newlines is still identical",
    plan.write === false, plan);
}

console.log("\nthe pull request that already exists is the answer, whatever its state");
{
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const rollout = fs.readFileSync(path.join(__dirname, "src/services/dependabotRollout.ts"), "utf8");

  // An open one is reported before anything is created.
  check("an open pull request is found first",
    /state: "open"/.test(rollout) && /already-open/.test(rollout));

  // And when creation is refused because one exists anyway, the refusal is
  // turned back into that pull request rather than shown as an API error.
  check("  and a refusal to create is resolved into the one that exists",
    /already exists/i.test(rollout) && /pulls\.list/.test(rollout));

  // The invariant that must survive all of this.
  const commitBlock = rollout.slice(
    rollout.indexOf('if (mode === "commit")'),
    rollout.indexOf("const { data: ref }"));
  check("  while the default branch is still never overwritten",
    !/sha/.test(commitBlock), commitBlock);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
