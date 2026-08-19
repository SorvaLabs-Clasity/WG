/**
 * Two ways a compliance check reported a repository as fine when it was not.
 *
 * **Ref matching.** Whether a ruleset covers a branch was decided with
 * `refs.some(r => r.includes(branch))` — a substring test. A ruleset scoped to
 * `refs/heads/maintenance` therefore "covered" `main`, and the check that asks
 * whether the default branch is protected read a rule about a different branch
 * and said yes. The `~DEFAULT_BRANCH` clause had the mirror-image fault: it was
 * compared against the literal "main", so a repository whose default is
 * `master` had its default-branch ruleset ignored entirely.
 *
 * **Fail-closed evaluation.** Three compliance rules returned `passed: true`
 * from their catch blocks. A 403 reading collaborators scored as "zero outside
 * collaborators"; an unreachable file scored as present; a query that could not
 * run scored every repository clean against it. Each one turns "we could not
 * look" into "we looked and it is fine", which is the direction a compliance
 * score must never be wrong in.
 */
import { refMatchesBranch, rulesetCoversBranch } from "./src/services/branchService";
import { calculateRepoCompliance } from "./src/services/complianceService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

process.env.GITHUB_ORG = process.env.GITHUB_ORG || "acme";

// ── what a ref condition means ────────────────────────────────────────
{
  check("a ruleset on maintenance does not protect main",
    refMatchesBranch("refs/heads/maintenance", "main") === false);
  check("  nor does any other branch whose name merely contains it",
    refMatchesBranch("refs/heads/main-archive", "main") === false);
  check("an exact ref does match",
    refMatchesBranch("refs/heads/main", "main") === true);

  check("~ALL covers every branch", refMatchesBranch("~ALL", "anything") === true);
  check("~DEFAULT_BRANCH follows the repository's own default",
    refMatchesBranch("~DEFAULT_BRANCH", "master", "master") === true);
  check("  and does not cover main when the default is master",
    refMatchesBranch("~DEFAULT_BRANCH", "main", "master") === false);
  check("  and matches nothing when the default is unknown",
    refMatchesBranch("~DEFAULT_BRANCH", "main", null) === false);

  check("a single star stops at a path separator",
    refMatchesBranch("refs/heads/release/*", "release/1.0") === true
    && refMatchesBranch("refs/heads/release/*", "release/1.0/hotfix") === false);
  check("  while a double star crosses one",
    refMatchesBranch("refs/heads/release/**", "release/1.0/hotfix") === true);
  check("a dot is a literal dot, not any character",
    refMatchesBranch("refs/heads/v1.0", "v1x0") === false);

  check("one matching entry in the include list is enough",
    rulesetCoversBranch(["refs/heads/other", "~ALL"], "main") === true);
  check("  and an absent include list covers nothing",
    rulesetCoversBranch(undefined, "main") === false);
}

// ── a rule that could not run has not passed ──────────────────────────
//
// Driven through the real calculateRepoCompliance against a GitHub that
// refuses everything with 403 — the shape of a token that lost a scope, or an
// organization that restricted the app mid-sweep.
(async () => {
  const refuse = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };

  const blindOctokit: any = {
    request: refuse,
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        listBranches: refuse,
        getRepoRulesets: refuse,
        getContent: refuse,
        listCollaborators: refuse,
        getBranchProtection: refuse,
      },
    },
  };

  const score = await calculateRepoCompliance(blindOctokit, "payments-api");
  const result = (id: string) => score.ruleResults.find(r => r.ruleId === id);

  const files = result("required-files");
  check("a required file that could not be read is not counted as present",
    files?.passed === false, files);
  check("  and the reason says so rather than naming it missing",
    /could not be read/.test(files?.detail ?? ""), files?.detail);

  const collabs = result("outside-collaborators");
  check("an unreadable collaborator list is not zero collaborators",
    collabs?.passed === false, collabs);
  check("  and the repository is not reported as having none",
    score.outsideCollaborators === 0 && collabs?.passed === false, {
      outsideCollaborators: score.outsideCollaborators, passed: collabs?.passed,
    });

  check("the score reflects what could not be checked",
    score.score < 100, score.score);

  // And the opposite case: a GitHub that answers "not there" is a real answer,
  // so a genuinely missing file is a failure with the ordinary wording rather
  // than an unreadable one.
  const missing = Object.assign(new Error("Not Found"), { status: 404 });
  const cleanOctokit: any = {
    request: async () => ({ data: { conditions: {}, rules: [] } }),
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        listBranches: async () => ({ data: [] }),
        getRepoRulesets: async () => ({ data: [] }),
        getContent: async () => { throw missing; },
        listCollaborators: async () => ({ data: [] }),
        getBranchProtection: async () => { throw missing; },
      },
    },
  };
  const honest = await calculateRepoCompliance(cleanOctokit, "web-platform");
  const honestFiles = honest.ruleResults.find(r => r.ruleId === "required-files");
  check("a genuinely absent file still reads as missing, not unreadable",
    honestFiles?.passed === false && /missing/.test(honestFiles?.detail ?? ""),
    honestFiles?.detail);
  const honestCollabs = honest.ruleResults.find(r => r.ruleId === "outside-collaborators");
  check("  and a collaborator list that really is empty passes",
    honestCollabs?.passed === true && honest.outsideCollaborators === 0, honestCollabs);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
