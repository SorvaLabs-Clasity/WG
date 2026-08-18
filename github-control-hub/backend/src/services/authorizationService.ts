import { Octokit } from "octokit";
import { createOctokit, getSystemToken, getOrg } from "../github/client";

/**
 * Who may change org-wide Control Hub settings.
 *
 * Everything a user does to a *repository* is authorized by GitHub itself —
 * those calls are made with the user's own token, so GitHub allows exactly what
 * it would allow had they used github.com directly, and there is nothing for us
 * to decide. See routes/branches.ts.
 *
 * Settings that are not GitHub actions have no such natural gate. A scanner
 * reads every repository with the app's own credentials, so it is restricted to
 * a named team.
 */
export const CONTROL_HUB_ADMIN_TEAM = process.env.CONTROL_HUB_ADMIN_TEAM || "control-hub-admins";

/**
 * Who may change AWS guardrails.
 *
 * Deliberately a separate team from CONTROL_HUB_ADMIN_TEAM. The two answer to
 * different people: GitHub auto-apply is the repo owners' concern, while
 * account-wide AWS changes belong to whoever administers the account. Sharing
 * one team would mean granting both to grant either.
 *
 * Org owners always qualify, so an unset or deleted team cannot lock everyone
 * out of their own account settings.
 */
export const AWS_ADMIN_TEAM = process.env.AWS_ADMIN_TEAM || "aws-guardrail-admins";

interface CacheEntry { value: boolean; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/** Drop cached answers — call after membership could have changed. */
export function invalidateAdminCache(login?: string): void {
  if (!login) { cache.clear(); return; }
  const suffix = `:${login.toLowerCase()}`;
  for (const key of [...cache.keys()]) if (key.endsWith(suffix)) cache.delete(key);
}

/**
 * True when the user is an org owner or a member of the admin team.
 *
 * Membership is read with the App/system token rather than the caller's: a user
 * cannot necessarily see a team they do not belong to, and "cannot see it"
 * would otherwise be indistinguishable from "is not in it".
 */
export async function isControlHubAdmin(login: string): Promise<boolean> {
  return isTeamMember(login, CONTROL_HUB_ADMIN_TEAM);
}

/** Who may create, edit, run or delete AWS guardrails. */
export async function isAwsAdmin(login: string): Promise<boolean> {
  return isTeamMember(login, AWS_ADMIN_TEAM);
}

/** Thrown when the answer is unknown, as opposed to "no". */
class Unanswerable extends Error {}

async function isTeamMember(login: string, team: string): Promise<boolean> {
  const key = `${team}:${login.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  let value: boolean;
  try {
    value = await resolve(login, team);
  } catch (err) {
    // Not cached, and not an answer about this person.
    //
    // A denial from a broken App token used to be stored for the full TTL, so a
    // credential problem lasting a second locked the caller out of every admin
    // screen for a minute after it healed — and gave them a plain "you are not
    // an admin", which is a claim about them rather than about the app.
    if (err instanceof Unanswerable) return false;
    throw err;
  }

  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function resolve(login: string, team: string): Promise<boolean> {
  const org = getOrg();
  const token = getSystemToken();
  if (!token) {
    console.warn(
      "[authorization] No GitHub App token, so team membership cannot be read — " +
      "denying this check without caching it. Everyone will look like a non-admin " +
      "until the App credentials work.",
    );
    throw new Unanswerable("no system token");
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
      team_slug: team,
      username: login,
    });
    return data.state === "active";
  } catch (err: any) {
    // 404 is the normal "not a member" answer, and also what a missing team returns.
    if (err?.status !== 404) {
      console.warn(`[authorization] Team membership check failed for "${login}" in "${team}": ${err?.message ?? err}`);
    }
    return false;
  }
}
