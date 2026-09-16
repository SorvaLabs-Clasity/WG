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
import { fromClassic, fromBranchRules, explainPush } from "./src/services/pushExplainer";
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
    // Anchored on the token, not on the shape of the call: the client gained a
    // feature label for the request counter, and the thing that matters here is
    // whose credentials go out, which is unchanged.
    /**
     * Whose credentials go out, which is the thing that matters — asked of the
     * client the route builds rather than of the call that uses it. The
     * previous version matched `getProtection(createOctokit(req.user!...` and
     * broke the moment that client was hoisted into a variable so a second read
     * could share it, with nothing about the credentials having changed. Its own
     * comment said it was anchored on the token and not on the shape of the
     * call; it was not.
     */
    const check1 = route.slice(route.indexOf('router.get("/push-check"'));
    const pushCheck = check1.slice(0, check1.indexOf("\nrouter."));
    check("protection is read with the caller's own token",
      /createOctokit\(req\.user!\.accessToken/.test(pushCheck)
        && !/createOctokit\(getSystemToken/.test(pushCheck),
      "the app's token would answer for people GitHub would not have answered");
    check("  and every read on this route uses that one client",
      (pushCheck.match(/createOctokit\(/g) ?? []).length === 1,
      "a second client here is a second chance to reach for the wrong token");
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

  /**
   * Organization rulesets, which the tab could not see at all.
   *
   * Reported as: "in the my work why can't I push tab, it shows that he has
   * access to push to main on all the repos he has write permissions on, even
   * though he can't. we use org level rulesets."
   *
   * Exactly that. The route asked `getProtection`, which is
   * `repos.getBranchProtection` — the *classic* API. It knows nothing about
   * rulesets and nothing whatever about organization-level ones, so it answered
   * 404, `getProtection` turned that into `null`, and `fromClassic(null)` into
   * "no protection" — which `explainPush` reports as nothing standing in your
   * way. The more thoroughly an organization protects its branches with org
   * rulesets, the more confidently the app told everybody they could push to
   * main.
   */
  console.log("\nrules that come from an organization ruleset");
  {
    // The shape `GET /repos/{owner}/{repo}/rules/branches/{branch}` returns:
    // flat, already merged across every ruleset that targets the branch, with
    // the source attached.
    const orgRules = [
      { type: "pull_request", ruleset_source_type: "Organization",
        ruleset_source: "org-protect-main", ruleset_id: 12,
        parameters: { required_approving_review_count: 2, require_code_owner_review: true,
          dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true } },
      { type: "non_fast_forward", ruleset_source_type: "Organization",
        ruleset_source: "org-protect-main", ruleset_id: 12 },
      { type: "deletion", ruleset_source_type: "Organization",
        ruleset_source: "org-protect-main", ruleset_id: 12 },
      { type: "required_signatures", ruleset_source_type: "Organization",
        ruleset_source: "org-protect-main", ruleset_id: 12 },
    ];

    const p = fromBranchRules(orgRules);
    check("an org ruleset is protection, where classic protection is absent",
      !!p, "this is the whole bug: null here reads as \"nothing is stopping you\"");
    check("  and it carries the approvals the ruleset asks for",
      p?.requirePr === true && p?.requiredApprovals === 2, p);
    check("  and the code-owner rule, under the name a ruleset uses for it",
      p?.requireCodeOwnerReviews === true,
      "`require_code_owner_review`, not classic's `require_code_owner_reviews`");

    /**
     * The inversion. Classic reports what is *allowed* (`allow_force_pushes`);
     * a ruleset reports the restriction's presence. Reading one as the other
     * turns every blocked branch into an open one.
     */
    check("  a restriction's presence is a prevention, not a permission",
      p?.preventForcePush === true && p?.preventDeletion === true, p);

    check("  and the ruleset is named, so the message can point at something real",
      p?.rulesetName === "org-protect-main", p?.rulesetName);

    // Nothing in force is a real answer and must not be confused with "could
    // not ask", which the route keeps as null.
    check("no rules in force is null, the same as no protection",
      fromBranchRules([]) === null && fromBranchRules(null) === null);

    /**
     * This endpoint returns only rules that are *in force*, so an evaluate-mode
     * ruleset contributes nothing to it. Setting `enforcement` here would make
     * explainPush's "not active, nothing is blocked" branch fire and clear
     * every rule above.
     */
    check("  and enforcement is left unset, because every rule here is active",
      p?.enforcement === undefined,
      "an evaluate-mode ruleset does not appear in this response at all");

    // And the explanation actually changes, which is the point of all of it.
    const asker = { login: "someone", role: "write" as const };
    const before = explainPush("repo", "main", fromClassic(null), asker, []);
    const after = explainPush("repo", "main", p, asker, []);
    check("so the tab stops saying the branch is unprotected",
      before.protected === false && after.protected === true);
    check("  and names what would actually block the push",
      after.cannotPushBecause.length > 0, after.cannotPushBecause);
  }

  console.log("\nand the route asks the endpoint that can see them");
  {
    const route = fs.readFileSync(`${__dirname}/src/routes/me.ts`, "utf8");
    const svc = fs.readFileSync(`${__dirname}/src/services/branchService.ts`, "utf8");

    check("there is a reader for the effective rules",
      /GET \/repos\/\{owner\}\/\{repo\}\/rules\/branches\/\{branch\}/.test(svc),
      "classic branch protection cannot answer this question");

    check("  and push-check asks it",
      /getBranchRules\(octokit, repo, branch\)/.test(route));

    check("  preferring it over classic protection when both answer",
      /fromBranchRules\(rules\) \?\? fromClassic\(raw\)/.test(route),
      "rules are the merged answer; classic cannot add to them");

    /**
     * Classic protection needs admin to read, and used to make the whole
     * question unanswerable on its own. A readable ruleset answers it whether
     * or not classic was refused.
     */
    check("  and only reports \"cannot tell\" when nothing at all could be read",
      /if \(unreadable && !effective\)/.test(route),
      "saying cannot-tell over a rule we can see is the same silence in a costume");
  }

  console.log("\nand the suggestion list works for the people who need it");
  {
    const route = fs.readFileSync(`${__dirname}/src/routes/me.ts`, "utf8");
    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/MyWorkPage.tsx`, "utf8");
    const access = fs.readFileSync(`${__dirname}/src/routes/access.ts`, "utf8");

    /**
     * The datalist was fed from `/api/access`, which is behind
     * `requireControlHubAdmin` — correctly, since that map aggregates the whole
     * organization's permissions. So suggestions worked for admins and 403'd
     * silently for everybody else, which is every person this tab is for.
     */
    check("the access map is still admin-only, which is why it cannot feed this",
      /router\.use\(requireControlHubAdmin\)/.test(access));

    check("the repo list comes from a question about yourself",
      /router\.get\("\/repos"/.test(route) && /accessForUser\(req\.user!\.login\)/.test(route));
    check("  and carries no gate, because it aggregates nothing",
      !/requireControlHubAdmin|requireAwsAdmin/.test(
        route.slice(route.indexOf('router.get("/repos"'), route.indexOf('router.get("/push-check"'))));
    check("  and the tab asks it rather than the access map",
      /useMyRepos\(true\)/.test(page) && !/useAccessRepos\(/.test(page.replace(/\/\*[\s\S]*?\*\//g, "")),
      "a comment may mention the old hook; a call must not");

    /**
     * An owner's access comes from the role, not from grants the graph records,
     * so their list is short. A short list that implies a limit is worse than
     * no list.
     */
    check("an owner is told the short list is not the whole story",
      /complete: me\.orgRole !== "owner"/.test(route)
      && /any other name works too/.test(page));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
