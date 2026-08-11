import type { Octokit } from "octokit";

/**
 * Asks GitHub, using the signed-in user's own token, whether they may write to
 * a repository.
 *
 * Most write paths in this app need no such check: they call GitHub with the
 * user's token and let the 403 be the answer. That does not work when one
 * request performs several writes, because the first few can succeed before a
 * later one is refused, leaving a half-applied change and an activity log that
 * disagrees with reality. Checking up front turns that into a clean refusal.
 *
 * This is a pre-flight, not the enforcement. The write itself still goes out
 * with the user's token, so a permission that changes between the check and
 * the call is still caught by GitHub.
 */

/**
 * What a repository operation needs.
 *
 * "push" is enough to create or delete an ordinary branch. Branch protection,
 * rulesets and Dependabot settings all require "admin" — GitHub will reject a
 * pusher, so asking for less here only moves the refusal later and makes it
 * harder to explain.
 */
export type RepoLevel = "push" | "admin";

export class RepoAccessDenied extends Error {
  constructor(public readonly repos: string[], public readonly level: RepoLevel = "push") {
    super(`No ${level} access to ${repos.join(", ")}`);
    this.name = "RepoAccessDenied";
  }
}

/** Repositories from `repos` where the user lacks `level`. */
export async function findUnwritable(
  octokit: Octokit, org: string, repos: string[], level: RepoLevel = "push"
): Promise<string[]> {
  const checks = await Promise.all(repos.map(async repo => {
    try {
      const { data } = await octokit.rest.repos.get({ owner: org, repo });
      // `permissions` is present because the request is authenticated as a user.
      // Absent means we cannot tell, and we do not guess in the permissive
      // direction.
      const has = level === "admin" ? data.permissions?.admin : data.permissions?.push;
      return has ? null : repo;
    } catch (err) {
      // 404 is GitHub declining to confirm a private repo exists. Treated the
      // same as 403 on purpose — distinguishing them would leak its existence.
      const status = (err as { status?: number })?.status;
      if (status === 403 || status === 404) return repo;
      throw err;
    }
  }));
  return checks.filter((r): r is string => r !== null);
}

/** Throws RepoAccessDenied unless the user has `level` on every repo given. */
export async function assertWritable(
  octokit: Octokit, org: string, repos: string[], level: RepoLevel = "push"
): Promise<void> {
  if (repos.length === 0) return;
  const denied = await findUnwritable(octokit, org, repos, level);
  if (denied.length > 0) throw new RepoAccessDenied(denied, level);
}
