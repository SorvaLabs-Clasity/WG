/**
 * Whether a screen opens, in one place and with no hooks around it.
 *
 * Kept apart from `usePermissionSet` so it can be tested with real answers in
 * hand — the hook's module reaches the API client, which only loads under Vite.
 */

/** Only the fields the decision reads, so a test need not build a whole answer. */
export interface TeamOrAnswer {
  enforced: boolean;
  inert: boolean;
  held: string[];
  failure: { reason: string; detail: string } | null;
}

/**
 * The decision itself, apart from the hooks, so it can be tested with a
 * real answer in hand rather than by reading the code.
 *
 * **Inert opens everything.** An install with no GitHub organization — an
 * AWS-only account — has no file, nothing to decide, and every gate on the
 * server passes. Falling back to the team there locked the AWS tab behind
 * `aws-guardrail-admins`, a team that cannot even be checked without an
 * organization, so the screen refused what the server allowed and named a team
 * nobody can join. Same for an organization that has never written a file: the
 * team is the rule, which is the line below.
 */
export function decideTeamOr(
  permissions: TeamOrAnswer | undefined,
  teams: { isAwsAdmin?: boolean; isControlHubAdmin?: boolean } | undefined,
  team: "control-hub" | "aws",
  keys: readonly string[],
): boolean {
  if (permissions?.inert) return true;
  if (permissions?.failure) return false;  // could not ask; said elsewhere
  if (permissions?.enforced) return keys.some(k => permissions.held.includes(k));
  return team === "aws" ? !!teams?.isAwsAdmin : !!teams?.isControlHubAdmin;
}
