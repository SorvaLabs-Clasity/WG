/**
 * Why a repository has a hundred Dependabot alerts and zero fix pull requests.
 *
 * The Vulnerabilities tab could say a repository was vulnerable and that
 * security updates were switched on, and both were true, and still no pull
 * request ever arrived. Somebody looking at that screen had no way to tell
 * apart the four reasons, which want four different responses:
 *
 *   - the repository is archived, so no pull request can be opened on it at all
 *   - the switch is off, so turn it on
 *   - not one alert has a patched version, so there is nothing to open and the
 *     zero is arithmetic rather than a failure
 *   - a dependabot.yml sets `target-branch`, which GitHub documents as taking
 *     the configuration out of scope for security updates: "you should not
 *     specify a target-branch"
 *
 * And the fifth case, the one that matters: none of the above, everything is
 * configured correctly and GitHub simply never scheduled the work. That is the
 * population a re-trigger can help, and it is invisible while it sits mixed in
 * with the four above.
 *
 * The rule underneath all of these, and the one this codebase keeps relearning:
 * a thing nobody could read is not a thing that is off. A repository the token
 * cannot administer must come back unknown, because announcing "security
 * updates are off" for a repository somebody has no permission to look at sends
 * them to a settings page they cannot open, for a problem they do not have.
 */
import fs from "fs";
import path from "path";
import { fixBlockerFor } from "./src/services/dependencyBlockers";
import type { RepoFacts } from "./src/services/dependencyService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const SRC = path.join(__dirname, "src");
const alert = (patched: string | null, over: any = {}) =>
  ({ patched_version: patched, relationship: "direct", ecosystem: "pip", ...over } as any);
const facts = (over: Partial<RepoFacts> = {}): RepoFacts =>
  ({ alertsEnabled: true, archived: false, config: null, ...over });

(async () => {
  console.log("the five states a repository with alerts and no pull requests can be in");
  {
    check("everything set up and still nothing: the one a re-trigger can help",
      fixBlockerFor([alert("1.2.4")], true, facts()) === null);

    check("  archived, where no pull request can be opened at all",
      fixBlockerFor([alert("1.2.4")], true, facts({ archived: true })) === "archived");

    check("  the switch is simply off",
      fixBlockerFor([alert("1.2.4")], false, facts()) === "fixes-off");

    check("  nothing is patchable, so zero is the right answer",
      fixBlockerFor([alert(null), alert(null)], true, facts()) === "no-patch");

    check("  a target-branch takes the config out of scope for security updates",
      fixBlockerFor([alert("1.2.4")], true,
        facts({ config: "version: 2\nupdates:\n  - package-ecosystem: npm\n    target-branch: develop\n" }))
        === "config-target-branch");
  }

  console.log("\ntransitive dependencies, which are often not Dependabot's to fix");
  {
    // GitHub: "Dependabot is unable to update an indirect or transitive
    // dependency if it would also require an update to the parent dependency."
    // A repository whose findings are all buried under parents somebody else
    // controls is not waiting on a trigger, and counting it as one sends
    // people to press a button that cannot help them.
    check("a patch that exists but sits under a parent dependency",
      fixBlockerFor([alert("1.2.4", { relationship: "transitive" })], true, facts()) === "transitive");

    // npm is the documented exception: Dependabot can bump a transitive
    // dependency there through the lockfile.
    check("  except on npm, where Dependabot can reach it through the lockfile",
      fixBlockerFor([alert("1.2.4", { relationship: "transitive", ecosystem: "npm" })], true, facts()) === null);

    // One directly fixable finding is one pull request owed.
    check("  and one direct finding among transitive ones still owes a pull request",
      fixBlockerFor(
        [alert("1.2.4", { relationship: "transitive" }), alert("2.0.0", { relationship: "direct" })],
        true, facts()) === null);

    // "unknown" and "inconclusive" are GitHub declining to say. Reading them
    // as transitive would be this codebase's oldest mistake wearing a new hat.
    check("  while unknown is not read as transitive",
      fixBlockerFor([alert("1.2.4", { relationship: "unknown" })], true, facts()) === null);
    check("  nor is inconclusive",
      fixBlockerFor([alert("1.2.4", { relationship: "inconclusive" })], true, facts()) === null);
    check("  nor is a missing relationship",
      fixBlockerFor([alert("1.2.4", { relationship: null })], true, facts()) === null);

    // Nothing patchable at all is the plainer answer of the two.
    check("  and no-patch still wins over transitive",
      fixBlockerFor([alert(null, { relationship: "transitive" })], true, facts()) === "no-patch");
  }

  console.log("\nthe relationship comes off the alert we already fetched");
  {
    const svc = fs.readFileSync(path.join(SRC, "services/dependencyService.ts"), "utf8");
    check("mapAlert keeps it", /relationship: /.test(svc));
  }

  console.log("\narchived outranks the rest, because nothing else can be acted on");
  {
    // Turning the switch on for an archived repository is a write that will be
    // accepted and change nothing, so it must not be the advice offered.
    check("an archived repository with the switch off still reads archived",
      fixBlockerFor([alert("1.2.4")], false, facts({ archived: true })) === "archived");
  }

  console.log("\none patchable alert is enough to make the repository stuck");
  {
    // A repository where 99 of 100 alerts have no fix still has one pull
    // request owed to it, and calling the whole repository unpatchable would
    // hide that one.
    check("ninety-nine unpatchable and one patchable is not no-patch",
      fixBlockerFor([alert(null), alert(null), alert("2.0.0")], true, facts()) === null);
  }

  console.log("\nunreadable is not off");
  {
    // fixesEnabled is undefined for a repository the token cannot administer.
    check("an unreadable switch is not reported as off",
      fixBlockerFor([alert("1.2.4")], undefined, facts()) === null,
      fixBlockerFor([alert("1.2.4")], undefined, facts()));

    // Same rule one level up: a GraphQL query that failed hands back no facts
    // at all, and every repository would otherwise read as not archived and
    // unconfigured, which are both assertions nobody made.
    check("  and missing facts produce no blocker rather than a wrong one",
      fixBlockerFor([alert("1.2.4")], true, null) === null);
  }

  console.log("\na config that does not set target-branch blocks nothing");
  {
    check("an ordinary dependabot.yml is not a blocker",
      fixBlockerFor([alert("1.2.4")], true,
        facts({ config: "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: \"/\"\n" })) === null);

    // "target-branch" inside a comment or a package name is not a setting.
    check("  and the word in a comment is not the setting",
      fixBlockerFor([alert("1.2.4")], true,
        facts({ config: "version: 2\n# do not set target-branch here\nupdates: []\n" })) === null);
  }

  console.log("\nthe repository facts ride the query that was already being made");
  {
    const svc = fs.readFileSync(path.join(SRC, "services/dependencyService.ts"), "utf8");

    // Reading .github/dependabot.yml over REST is one request per repository,
    // which is 351 on this organization every time the tab is opened. It is
    // the exact cost the alert-status query was rewritten to avoid, and
    // reintroducing it here would undo that.
    check("the config is read through GraphQL, not a call per repository",
      /dependabot\.yml/.test(svc) && !/getContent|repos\.getContent/.test(svc));

    check("  on the same query as the alert flag, so it costs no extra request",
      /hasVulnerabilityAlertsEnabled[\s\S]{0,400}dependabot\.yml/.test(svc));

    check("  and both spellings are read, because GitHub accepts either",
      /dependabot\.yml/.test(svc) && /dependabot\.yaml/.test(svc));

    check("  archived comes from the same query too", /isArchived/.test(svc));

    // One reader, so the flag and the facts can never disagree about a
    // repository the way two queries paging separately could.
    check("  and the old alert-status reader is now a view of the same facts",
      /fetchRepoFacts/.test(svc)
        && /export async function fetchRepoAlertStatus[\s\S]{0,400}fetchRepoFacts/.test(svc));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
