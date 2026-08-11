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

export class RepoAccessDenied extends Error {
  constructor(public readonly repos: string[]) {
    super(`No write access to ${repos.join(", ")}`);
    this.name = "RepoAccessDenied";
  }
}

/** Repositories from `repos` the user cannot write to. */
export async function findUnwritable(
  octokit: Octokit, org: string, repos: string[]
): Promise<string[]> {
  const checks = await Promise.all(repos.map(async repo => {
    try {
      const { data } = await octokit.rest.repos.get({ owner: org, repo });
      // `permissions` is present because the request is authenticated as a user.
      // Absent means we cannot tell, and we do not guess in the permissive
      // direction.
      return data.permissions?.push ? null : repo;
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

/** Throws RepoAccessDenied unless the user can write to every repo given. */
export async function assertWritable(
  octokit: Octokit, org: string, repos: string[]
): Promise<void> {
  if (repos.length === 0) return;
  const denied = await findUnwritable(octokit, org, repos);
  if (denied.length > 0) throw new RepoAccessDenied(denied);
}
