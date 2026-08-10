import { Octokit } from "octokit";
import { createOctokit, getSystemToken, getOrg } from "../github/client";

/**
 * Who may change org-wide Control Hub settings.
 *
 * Everything a user does to a *repository* is authorised by GitHub itself —
 * those calls are made with the user's own token, so GitHub allows exactly what
 * it would allow had they used github.com directly, and there is nothing for us
 * to decide. See routes/templates.ts.
 *
 * Settings that are not GitHub actions have no such natural gate. Turning on
 * auto-apply changes every repository created from that moment on, so it is
 * restricted to a named team.
 */
export const CONTROL_HUB_ADMIN_TEAM = process.env.CONTROL_HUB_ADMIN_TEAM || "control-hub-admins";

interface CacheEntry { value: boolean; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/** Drop a user's cached answer — call after their membership could have changed. */
export function invalidateAdminCache(login?: string): void {
  if (login) cache.delete(login.toLowerCase());
  else cache.clear();
}

/**
 * True when the user is an org owner or a member of the admin team.
 *
 * Membership is read with the App/system token rather than the caller's: a user
 * cannot necessarily see a team they do not belong to, and "cannot see it"
 * would otherwise be indistinguishable from "is not in it".
 */
export async function isControlHubAdmin(login: string): Promise<boolean> {
  const key = login.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  const value = await resolve(login);
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function resolve(login: string): Promise<boolean> {
  const org = getOrg();
  const token = getSystemToken();
  if (!token) {
    console.warn("[authorization] No system token available; denying admin check");
    return false;
  }
  const octokit: Octokit = createOctokit(token);

  // Org owners always qualify — otherwise an empty or deleted team could lock
  // everyone out of their own settings.
  try {
    const { data } = await octokit.rest.orgs.getMembershipForUser({ org, username: login });
    if (data.role === "admin") return true;
  } catch (err: any) {
    if (err?.status !== 404) {
      console.warn(`[authorization] Org membership check failed for "${login}": ${err?.message ?? err}`);
    }
  }

  try {
    const { data } = await octokit.rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: CONTROL_HUB_ADMIN_TEAM,
      username: login,
    });
    return data.state === "active";
  } catch (err: any) {
    // 404 is the normal "not a member" answer, and also what a missing team returns.
    if (err?.status !== 404) {
      console.warn(`[authorization] Team membership check failed for "${login}": ${err?.message ?? err}`);
    }
    return false;
  }
}
