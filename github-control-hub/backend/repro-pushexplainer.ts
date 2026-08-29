/**
 * "Why can't I push?", answered before somebody tries.
 *
 * The rules were already stored in full and already on screen, as a settings
 * form, which is the right shape for changing them and the wrong shape for the
 * question people actually have. A form says `requireCodeOwnerReviews: true`.
 * It does not say that somebody in CODEOWNERS has to approve.
 *
 * Two things are asserted. The mapping from GitHub's raw shape, which contains
 * two inversions and a presence-means-required field and is therefore exactly
 * where a wrong answer comes from. And the explanation itself, where the only
 * unforgivable direction of error is telling somebody a rule does not apply to
 * them when it does.
 *
 * Run:  npx tsx repro-pushexplainer.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { fromClassic, explainPush } from "./src/services/pushExplainer";
import type { BranchProtection } from "./src/services/branchService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const me = { login: "alice", role: "write" };
const admin = { login: "alice", role: "admin" };
const prot = (over: Partial<BranchProtection> = {}): BranchProtection => ({
  type: "classic", requirePr: false, requiredApprovals: 0,
  dismissStaleReviews: false, requireCodeOwnerReviews: false,
  requireConversationResolution: false, requireStatusChecks: false,
  strictStatusChecks: false, requireSignedCommits: false,
  requireLinearHistory: false, enforceAdmins: true,
  preventForcePush: false, preventDeletion: false,
  ...over,
} as BranchProtection);

const labels = (e: { cannotPushBecause: any[]; mergeNeeds: any[] }) =>
  [...e.cannotPushBecause, ...e.mergeNeeds].map(r => r.label);

(async () => {
  // ── GitHub's raw shape, where the wrong answers come from ───────────
  {
    // GitHub reports what is ALLOWED; the app stores what is PREVENTED.
    check("force push allowed means force push is not prevented",
      fromClassic({ allow_force_pushes: { enabled: true } })!.preventForcePush === false);
    check("  and absent means prevented, which is GitHub's own default",
      fromClassic({})!.preventForcePush === true,
      "reading the missing key as false would say force pushing is fine when it is not");
    check("  deletions invert the same way",
      fromClassic({ allow_deletions: { enabled: true } })!.preventDeletion === false);

    // Presence is the rule, not the count inside it.
    check("a review block with zero approvals still requires a pull request",
      fromClassic({ required_pull_request_reviews: { required_approving_review_count: 0 } })!.requirePr === true,
      "reading the count alone lets a direct push look permitted");
    check("  and no review block means no pull request is required",
      fromClassic({})!.requirePr === false);

    check("nested optionals do not throw on a sparse response",
      fromClassic({ required_status_checks: null, restrictions: null })!.requireStatusChecks === false);
    check("  no protection at all maps to null, not an empty rule set",
      fromClassic(null) === null,
      "an empty rule set reads as 'nothing is stopping you'");

    // GitHub returns either shape depending on the endpoint's age.
    check("check names are read from either contexts or checks",
      JSON.stringify(fromClassic({ required_status_checks: { checks: [{ context: "build" }] } })!.statusCheckContexts)
        === '["build"]');
  }

  // ── an unprotected branch is not an unknown one ─────────────────────
  {
    const e = explainPush("web", "feature", null, me);
    check("an unprotected branch says so",
      e.protected === false && e.cannotPushBecause.length === 0);
  }

  // ── what stops a push, versus what only gates a merge ───────────────
  {
    const e = explainPush("web", "main", prot({ requirePr: true, requiredApprovals: 2 }), me);
    check("needing a pull request stops the push",
      e.cannotPushBecause.some(r => r.label === "Pull request required"));
    check("  while the approvals only gate the merge",
      e.mergeNeeds.some(r => /2 approvals/.test(r.label))
      && !e.cannotPushBecause.some(r => /approval/.test(r.label)),
      labels(e));
    check("  and dismissal is mentioned where it will surprise somebody",
      /dismisses the approvals/.test(
        explainPush("web", "main", prot({ requirePr: true, requiredApprovals: 1, dismissStaleReviews: true }), me)
          .mergeNeeds[0].detail));

    // "A pull request is required" and "somebody has to approve it" are
    // different rules, and people assume the first implies the second.
    const noApproval = explainPush("web", "main", prot({ requirePr: true, requiredApprovals: 0 }), me);
    check("a pull request with no required approval says that outright",
      noApproval.mergeNeeds.some(r => r.label === "No approval required"),
      labels(noApproval));

    check("signed commits are a push-time rule, not a merge-time one",
      explainPush("web", "main", prot({ requireSignedCommits: true }), me)
        .cannotPushBecause.some(r => /signed/i.test(r.label)),
      "it is refused at push, and calling it a merge rule sends people the wrong way");
  }

  // ── push restrictions, where being wrong is worst ───────────────────
  {
    const restricted = prot({ restrictPushes: true, pushRestrictionUsers: ["bob"], pushRestrictionTeams: ["platform"] });
    check("somebody not on the list is told they cannot push",
      explainPush("web", "main", restricted, me, []).cannotPushBecause
        .some(r => r.label === "Pushes are restricted"));
    check("  a named user is not",
      explainPush("web", "main", restricted, { login: "bob", role: "write" }, []).cannotPushBecause
        .every(r => r.label !== "Pushes are restricted"));
    check("  nor is somebody in a named team",
      explainPush("web", "main", restricted, me, ["platform"]).cannotPushBecause
        .every(r => r.label !== "Pushes are restricted"));
    check("  matched case-insensitively, as GitHub does",
      explainPush("web", "main", restricted, { login: "BOB", role: "write" }, []).cannotPushBecause
        .every(r => r.label !== "Pushes are restricted"));
    // An empty allow-list with the restriction on is a real configuration.
    check("  an empty list means nobody, not everybody",
      /Nobody may push/.test(explainPush("web", "main",
        prot({ restrictPushes: true }), me, []).cannotPushBecause[0].detail));
  }

  // ── the most misread field on the form ──────────────────────────────
  //
  // enforceAdmins OFF means admins are NOT bound, which is the opposite of what
  // "enforce admins: false" reads like at a glance.
  {
    check("an admin is exempt when the rules are not enforced for admins",
      explainPush("web", "main", prot({ requirePr: true, enforceAdmins: false }), admin).canBypass);
    check("  and is not when they are",
      !explainPush("web", "main", prot({ requirePr: true, enforceAdmins: true }), admin).canBypass);
    check("  a writer is never exempt by role",
      !explainPush("web", "main", prot({ requirePr: true, enforceAdmins: false }), me).canBypass,
      "the exemption is for admins, and granting it wider is the unsafe direction");
    check("  the exemption still says the push is recorded",
      /recorded/.test(explainPush("web", "main",
        prot({ requirePr: true, enforceAdmins: false }), admin).bypassNote ?? ""));

    // Bypass actors are role and team ids. Resolving one to "you" would be a
    // guess in the direction that must not be wrong.
    const withActors = explainPush("web", "main",
      prot({ requirePr: true, bypassActors: [{ actor_id: 1, actor_type: "Team", bypass_mode: "always" }] as any }), me);
    check("a bypass list does not claim the reader is on it",
      !withActors.canBypass && /unless you are on that list/.test(withActors.bypassNote ?? ""),
      withActors.bypassNote);
  }

  // ── a ruleset that is not switched on stops nothing ─────────────────
  {
    for (const [mode, word] of [["evaluate", "evaluate mode"], ["disabled", "disabled"]] as const) {
      const e = explainPush("web", "main",
        prot({ type: "ruleset", enforcement: mode as any, rulesetName: "Prod", requirePr: true }), me);
      check(`a ruleset in ${mode} reports no blockers`,
        e.cannotPushBecause.length === 0 && e.mergeNeeds.length === 0);
      check(`  and says why it is not blocking`, new RegExp(word).test(e.bypassNote ?? ""), e.bypassNote);
    }
    check("an active ruleset does block",
      explainPush("web", "main",
        prot({ type: "ruleset", enforcement: "active", requirePr: true }), me).cannotPushBecause.length > 0);
  }

  // ── the route's own refusals ────────────────────────────────────────
  {
    const route = fs.readFileSync("./src/routes/me.ts", "utf8");
    check("protection is read with the caller's own token",
      /getProtection\(createOctokit\(req\.user!\.accessToken\)/.test(route),
      "the app's token would answer for people GitHub would not have answered");
    check("  and being unable to read the rules is not reported as having none",
      /unreadable/.test(route) && /does not mean there are none/.test(route));
    check("no access to the repo is said outright",
      /nothing you push there would be accepted/.test(route),
      "an empty rule list reads as nothing stopping you");
    check("who can approve comes with it",
      /approvers/.test(route) && /accessForRepo\(repo\)/.test(route),
      "a rule you cannot satisfy alone is only actionable with a name");

    check("the ship log says when detailed logging is what made it empty",
      /detailedLogging: !!detailed\.enabled/.test(route),
      "no merge rows and no shipping are the same empty list");
    check("  and re-checks the actor exactly after a free-text search",
      /e\.actor\?\.toLowerCase\(\) === login\.toLowerCase\(\)/.test(route),
      "a hit on somebody's name inside a details string is not them having done it");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
