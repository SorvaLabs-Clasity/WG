/**
 * Whether a ruleset actually covers the branch it is asked about.
 *
 * Decided with
 * `refs.some(r => r.includes(branch))`, a substring test. A ruleset scoped to
 * `refs/heads/maintenance` therefore "covered" `main`, and the check that asks
 * whether the default branch is protected read a rule about a different branch
 * and said yes. The `~DEFAULT_BRANCH` clause had the mirror-image fault: it was
 * compared against the literal "main", so a repository whose default is
 * `master` had its default-branch ruleset ignored entirely.
 *
 * This began life alongside a set of fail-closed assertions about the compliance
 * scorer, which has since been removed. Nothing displayed its scores. The ref
 * matching stayed: `branchService` is what the scanners and the branch checks
 * ask, and a substring test there is wrong in exactly the same direction.
 */
import { refMatchesBranch, rulesetCoversBranch } from "./src/services/branchService";

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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
