import type { BranchProtection } from "./branchService";

/**
 * Why a push or a merge will be refused, before it is refused.
 *
 * The rules are already stored, in full, and are already shown, as a settings
 * form, which is the right shape for changing them and the wrong shape for the
 * question people actually have, which is "what will happen if I try". A form
 * says `requireCodeOwnerReviews: true`. It does not say "somebody listed in
 * CODEOWNERS has to approve, and you are not one of them".
 *
 * Everything here is a pure function of the protection record and who is
 * asking. Nothing reads GitHub.
 */

/**
 * GitHub's classic protection response, in the app's own shape.
 *
 * The raw fields are read ad hoc in several places already, each doing its own
 * `prot.required_pull_request_reviews?.required_approving_review_count || 0`.
 * The mapping belongs in one place: every one of those expressions is a chance
 * to read a nested optional wrong, and reading one wrong here means telling
 * somebody a rule does not apply to them when it does.
 *
 * Note the two inversions. GitHub reports what is *allowed* for force pushes
 * and deletions, and the rest of the app stores what is *prevented*; and
 * `required_pull_request_reviews` being present at all is what makes a pull
 * request mandatory, regardless of how many approvals it asks for.
 */
export function fromClassic(raw: Record<string, any> | null): BranchProtection | null {
  if (!raw) return null;
  const pr = raw.required_pull_request_reviews;
  const checks = raw.required_status_checks;
  const restrictions = raw.restrictions;
  return {
    type: "classic",
    requirePr: !!pr,
    requiredApprovals: pr?.required_approving_review_count ?? 0,
    dismissStaleReviews: !!pr?.dismiss_stale_reviews,
    requireCodeOwnerReviews: !!pr?.require_code_owner_reviews,
    requireLastPushApproval: !!pr?.require_last_push_approval,
    requireConversationResolution: !!raw.required_conversation_resolution?.enabled,
    requireStatusChecks: !!checks,
    strictStatusChecks: !!checks?.strict,
    statusCheckContexts: checks?.contexts ?? (checks?.checks ?? []).map((c: any) => c?.context).filter(Boolean),
    requireSignedCommits: !!raw.required_signatures?.enabled,
    requireLinearHistory: !!raw.required_linear_history?.enabled,
    enforceAdmins: !!raw.enforce_admins?.enabled,
    // GitHub says what is allowed; this says what is prevented.
    preventForcePush: !(raw.allow_force_pushes?.enabled ?? false),
    preventDeletion: !(raw.allow_deletions?.enabled ?? false),
    restrictPushes: !!restrictions,
    pushRestrictionUsers: (restrictions?.users ?? []).map((u: any) => u?.login).filter(Boolean),
    pushRestrictionTeams: (restrictions?.teams ?? []).map((t: any) => t?.slug).filter(Boolean),
    pushRestrictionApps: (restrictions?.apps ?? []).map((a: any) => a?.slug).filter(Boolean),
  };
}

export type Gate = "push" | "merge";

export interface Rule {
  /** A few words, for a list. */
  label: string;
  /** What it means for the person reading, in a sentence. */
  detail: string;
  /** Whether this stops a direct push, or only gates the merge of a request. */
  gate: Gate;
}

export interface Asker {
  login: string;
  /** Their strongest role on the repository: admin, maintain, write, read. */
  role: string;
}

export interface PushExplanation {
  repo: string;
  branch: string;
  protected: boolean;
  /** Empty means a direct push will be accepted. */
  cannotPushBecause: Rule[];
  /** What a pull request into this branch will have to satisfy. */
  mergeNeeds: Rule[];
  /** Whether this person's own role lets them go around the rules above. */
  canBypass: boolean;
  bypassNote?: string;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Whether the asker is named in the push allow-list.
 *
 * Only meaningful when `restrictPushes` is set. An empty list with the
 * restriction on means nobody may push directly, which is a real configuration
 * and not a mistake.
 */
function inPushList(p: BranchProtection, asker: Asker, teams: string[]): boolean {
  const me = asker.login.toLowerCase();
  if ((p.pushRestrictionUsers ?? []).some(u => u.toLowerCase() === me)) return true;
  const mine = new Set(teams.map(t => t.toLowerCase()));
  return (p.pushRestrictionTeams ?? []).some(t => mine.has(t.toLowerCase()));
}

/**
 * Whether an administrator is exempt here.
 *
 * `enforceAdmins` is the switch that decides whether the rules apply to
 * administrators too, and it is the single most misunderstood field on the
 * form: off means admins are *not* bound, which is the opposite of what
 * "enforce admins: false" reads like at a glance.
 */
function adminIsExempt(p: BranchProtection, asker: Asker): boolean {
  return asker.role === "admin" && !p.enforceAdmins;
}

export function explainPush(
  repo: string,
  branch: string,
  protection: BranchProtection | null,
  asker: Asker,
  teams: string[] = [],
): PushExplanation {
  // Nothing protects it. Said plainly rather than as an empty list of rules,
  // which reads identically to "we could not find the rules".
  if (!protection) {
    return {
      repo, branch, protected: false,
      cannotPushBecause: [], mergeNeeds: [], canBypass: false,
    };
  }

  const p = protection;
  const cannotPushBecause: Rule[] = [];
  const mergeNeeds: Rule[] = [];

  // A ruleset that is not active does not stop anything. Reporting its rules as
  // blockers would send somebody to change settings that were already off.
  const inactive = p.type !== "classic" && p.enforcement && p.enforcement !== "active";
  if (inactive) {
    return {
      repo, branch, protected: true,
      cannotPushBecause: [], mergeNeeds: [],
      canBypass: true,
      bypassNote: p.enforcement === "evaluate"
        ? `The "${p.rulesetName ?? "ruleset"}" ruleset is in evaluate mode, so it reports but does not block.`
        : `The "${p.rulesetName ?? "ruleset"}" ruleset is disabled.`,
    };
  }

  // ── what stops a direct push ────────────────────────────────────────
  if (p.requirePr) {
    cannotPushBecause.push({
      gate: "push",
      label: "Pull request required",
      detail: `Commits cannot be pushed straight to ${branch}. Push to another branch and open a pull request.`,
    });
  }

  if (p.restrictPushes && !inPushList(p, asker, teams)) {
    const allowed = [...(p.pushRestrictionUsers ?? []), ...(p.pushRestrictionTeams ?? [])];
    cannotPushBecause.push({
      gate: "push",
      label: "Pushes are restricted",
      detail: allowed.length
        ? `Only ${allowed.slice(0, 4).join(", ")}${allowed.length > 4 ? " and others" : ""} may push to ${branch}.`
        : `Nobody may push directly to ${branch}.`,
    });
  }

  if (p.preventForcePush) {
    cannotPushBecause.push({
      gate: "push",
      label: "No force pushing",
      detail: "A rewritten history will be rejected. Add a commit instead of amending or rebasing what is already pushed.",
    });
  }

  if (p.requireSignedCommits) {
    cannotPushBecause.push({
      gate: "push",
      label: "Commits must be signed",
      detail: "Every commit needs a verified signature. An unsigned commit is refused even inside a pull request.",
    });
  }

  if (p.requireLinearHistory) {
    cannotPushBecause.push({
      gate: "push",
      label: "Linear history",
      detail: "Merge commits are refused. Rebase or squash instead.",
    });
  }

  // ── what a pull request will have to satisfy ────────────────────────
  if (p.requiredApprovals > 0) {
    mergeNeeds.push({
      gate: "merge",
      label: `${plural(p.requiredApprovals, "approval")}`,
      detail: `${plural(p.requiredApprovals, "review")} must approve before it can be merged.`
        + (p.dismissStaleReviews ? " A new commit dismisses the approvals you already had." : ""),
    });
  } else if (p.requirePr) {
    // Worth saying outright. "A pull request is required" and "somebody has to
    // approve it" are different rules, and people assume the first implies the
    // second.
    mergeNeeds.push({
      gate: "merge",
      label: "No approval required",
      detail: "A pull request is needed, but nobody has to approve it. You can open and merge it yourself.",
    });
  }

  if (p.requireCodeOwnerReviews) {
    mergeNeeds.push({
      gate: "merge",
      label: "Code owner review",
      detail: "Somebody listed in CODEOWNERS for the files you changed has to approve, on top of any other approvals.",
    });
  }

  if (p.requireLastPushApproval) {
    mergeNeeds.push({
      gate: "merge",
      label: "Someone else must approve last",
      detail: "The most recent push cannot be approved by whoever made it, so you cannot approve your own final commit.",
    });
  }

  if (p.requireStatusChecks) {
    const named = p.statusCheckContexts ?? [];
    mergeNeeds.push({
      gate: "merge",
      label: named.length ? `${plural(named.length, "check")} must pass` : "Checks must pass",
      detail: (named.length ? `${named.slice(0, 4).join(", ")}${named.length > 4 ? " and others" : ""} must be green.` : "Required checks must be green.")
        + (p.strictStatusChecks ? ` The branch must also be up to date with ${branch} before merging.` : ""),
    });
  }

  if (p.requireConversationResolution) {
    mergeNeeds.push({
      gate: "merge",
      label: "Conversations resolved",
      detail: "Every review comment has to be marked resolved.",
    });
  }

  if (p.requireDeployments && (p.requiredDeploymentEnvironments ?? []).length) {
    mergeNeeds.push({
      gate: "merge",
      label: "Deployed first",
      detail: `It must have been deployed to ${(p.requiredDeploymentEnvironments ?? []).join(", ")}.`,
    });
  }

  if ((p.allowedMergeMethods ?? []).length) {
    mergeNeeds.push({
      gate: "merge",
      label: "Merge method",
      detail: `Only ${(p.allowedMergeMethods ?? []).join(" or ")} is allowed here.`,
    });
  }

  // ── whether any of it applies to this person ────────────────────────
  const exemptAdmin = adminIsExempt(p, asker);
  const bypass = (p.bypassActors ?? []).length > 0;

  return {
    repo, branch, protected: true,
    cannotPushBecause,
    mergeNeeds,
    canBypass: exemptAdmin,
    bypassNote: exemptAdmin
      ? "You are an administrator here and these rules are not enforced for administrators, so you can push anyway. It will still be recorded."
      // Named without claiming it is them: the bypass list holds role and team
      // ids, and resolving them to "you" would be a guess in the one direction
      // that must not be wrong.
      : bypass
        ? `Some roles or teams are allowed to bypass these rules. You are not exempt as an administrator, so they apply to you unless you are on that list.`
        : undefined,
  };
}
