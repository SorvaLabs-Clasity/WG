import { createOctokit, getOrg } from "../github/client";

/**
 * Keeps org membership honest between logins.
 *
 * Membership was checked once, at the OAuth callback, and never again — so
 * someone removed from the organisation kept full access until their JWT
 * expired. Offboarding that takes effect "eventually" is not offboarding.
 *
 * Re-checking on every request would mean a GitHub call per request, so the
 * answer is cached briefly. The window is the worst-case delay between IT
 * removing someone and this app locking them out.
 */

const TTL_MS = 5 * 60 * 1000;

/**
 * How long a cached "yes" stays usable when GitHub cannot be reached. Longer
 * than the TTL on purpose: a GitHub outage should not sign out the whole
 * company, but it should not extend access indefinitely either.
 */
const STALE_GRACE_MS = 60 * 60 * 1000;

interface Cached {
  member: boolean;
  checkedAt: number;
}

const cache = new Map<number, Cached>();

/** Test seam. The real one asks GitHub. */
export interface MembershipDeps {
  check: (accessToken: string, login: string) => Promise<boolean>;
  now: () => number;
}

const realDeps: MembershipDeps = {
  check: async (accessToken, login) => {
    const octokit = createOctokit(accessToken);
    try {
      await octokit.rest.orgs.checkMembershipForUser({ org: getOrg(), username: login });
      return true;
    } catch (err) {
      const status = (err as { status?: number })?.status;
      // 404 is GitHub's answer for "not a member". 302 means our own token
      // cannot see the membership, which is equally not a yes.
      if (status === 404 || status === 302 || status === 403) return false;
      throw err;
    }
  },
  now: () => Date.now(),
};

export function forgetMembership(githubId: number): void {
  cache.delete(githubId);
}

/** Only for tests. */
export function clearMembershipCache(): void {
  cache.clear();
}

/**
 * Whether this user is still in the organisation.
 *
 * A definite "no" from GitHub is always obeyed. An unreachable GitHub falls
 * back to the last known answer within the grace window, and denies once that
 * runs out — failing open forever would make the check decorative.
 */
export async function isStillOrgMember(
  githubId: number, login: string, accessToken: string,
  deps: MembershipDeps = realDeps,
): Promise<boolean> {
  const hit = cache.get(githubId);
  const now = deps.now();

  if (hit && now - hit.checkedAt < TTL_MS) return hit.member;

  try {
    const member = await deps.check(accessToken, login);
    cache.set(githubId, { member, checkedAt: now });
    return member;
  } catch {
    // Could not ask. A recent yes carries over; anything else is a no. Falling
    // back to the cached value unconditionally would let one stale yes hold
    // open forever, which is the failure this whole check exists to prevent.
    if (hit?.member) return now - hit.checkedAt < STALE_GRACE_MS;
    return false;
  }
}
