import type { RepoFacts } from "./dependencyService";

/**
 * Why this repository has open alerts and no fix pull requests.
 *
 * `null` is the interesting answer, not the boring one: it means the switch is
 * on, a patch exists, nothing in the repository is refusing, and GitHub simply
 * never did the work. That is the population worth re-triggering, and while it
 * sits mixed in with archived repositories and unpatchable alerts nobody can
 * see how large it is.
 */
export type FixBlocker =
  | "archived"
  | "fixes-off"
  | "no-patch"
  | "config-target-branch"
  | "transitive";

/**
 * Does this configuration set `target-branch`?
 *
 * GitHub's wording is that for a configuration to apply to security updates
 * "you should not specify a target-branch", so a repository with one gets no
 * security pull requests however many times somebody presses the switch. It is
 * worth reading for exactly that reason: it is invisible from every other
 * screen, and it makes the switch look broken.
 *
 * Comments are stripped first. The word appears in GitHub's own commented
 * examples, and matching those would accuse a correctly configured repository.
 */
function setsTargetBranch(config: string): boolean {
  const code = config
    .split("\n")
    .map(line => line.replace(/#.*$/, ""))
    .join("\n");
  return /(^|\s)target-branch\s*:/m.test(code);
}

/**
 * `fixesEnabled` is undefined for a repository the caller cannot administer,
 * and `facts` is null when the query that reads them failed. Both mean nobody
 * knows, and neither is a finding: naming a blocker nobody established sends
 * somebody to fix a repository that may have nothing wrong with it.
 */
export function fixBlockerFor(
  alerts: { patched_version?: string | null; relationship?: string | null; ecosystem?: string }[],
  fixesEnabled: boolean | undefined,
  facts: RepoFacts | null,
): FixBlocker | null {
  // First, because it makes every other answer moot: an archived repository
  // accepts the switch and still opens nothing, so advising the switch there
  // is advising a write that changes nothing.
  if (facts?.archived) return "archived";

  if (fixesEnabled === false) return "fixes-off";

  if (facts?.config && setsTargetBranch(facts.config)) return "config-target-branch";

  // One patchable alert is one pull request owed, so this is the state of every
  // alert rather than most of them. A repository with 99 unpatchable findings
  // and one fixable one is stuck, not unpatchable.
  if (alerts.length > 0 && alerts.every(a => !a.patched_version)) return "no-patch";

  /**
   * A patch exists, but not one Dependabot can reach.
   *
   * GitHub: "Dependabot is unable to update an indirect or transitive
   * dependency if it would also require an update to the parent dependency."
   * npm is the documented exception, where the lockfile can be bumped
   * directly, so a transitive finding there is still Dependabot's to fix.
   *
   * Only "transitive" counts. "unknown" and "inconclusive" are GitHub
   * declining to say, and reading a non-answer as a reason is the mistake this
   * whole file exists to avoid.
   */
  const fixable = alerts.filter(a => a.patched_version);
  const outOfReach = (a: typeof fixable[number]) =>
    a.relationship === "transitive" && String(a.ecosystem ?? "").toLowerCase() !== "npm";
  if (fixable.length > 0 && fixable.every(outOfReach)) return "transitive";

  return null;
}

/** What somebody should do about it, in the words of the thing they would do. */
export const BLOCKER_LABEL: Record<FixBlocker, string> = {
  "archived": "Archived, so no pull request can be opened",
  "fixes-off": "Security updates are off",
  "no-patch": "No patched version exists yet",
  "config-target-branch": "Its dependabot.yml sets target-branch",
  "transitive": "Buried under a parent dependency",
};

/**
 * Whether this repository's configuration groups security updates.
 *
 * Changes what a healthy number of pull requests looks like: grouped,
 * Dependabot opens one per manifest carrying every bump, rather than one per
 * package. A screen that does not know this shows a finished repository as a
 * stalled one.
 *
 * Comments are stripped first, for the same reason as target-branch: the
 * phrase appears in GitHub's own commented examples.
 */
export function groupsSecurityUpdates(config: string | null | undefined): boolean {
  if (!config) return false;
  const code = config.split("\n").map(line => line.replace(/#.*$/, "")).join("\n");
  return /applies-to\s*:\s*security-updates/.test(code);
}
