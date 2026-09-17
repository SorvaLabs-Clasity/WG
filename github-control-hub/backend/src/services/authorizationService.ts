import { Octokit } from "octokit";
import { createOctokit, getSystemToken, getOrg } from "../github/client";

/**
 * Who may change org-wide Control Hub settings.
 *
 * Everything a user does to a *repository* is authorized by GitHub itself,
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
 * Only the team qualifies. Org owners used to, so an unset or deleted team could not lock everyone
 * out of their own account settings.
 */
export const AWS_ADMIN_TEAM = process.env.AWS_ADMIN_TEAM || "aws-guardrail-admins";

/**
 * How somebody qualifies, not merely whether.
 *
 * "owner" is no longer returned — see `adminVia`. The value is kept in the type
 * so an older client reading `adminVia` off the wire still parses, and so the
 * history of why it existed stays readable.
 *
 * It used to mean: an organization owner passes every
 * check here by design — otherwise an empty or deleted team could lock everyone
 * out of their own settings — and nothing in the app used to say so. Somebody
 * who removes themselves from both teams, sees no change whatsoever, and is
 * told only "you are an admin" has no way to tell a working rule from a broken
 * one, and the reasonable conclusion is that the permissions are broken.
 */
export type AdminVia = "owner" | "team" | null;

interface CacheEntry { value: AdminVia; expires: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/** Drop cached answers, call after membership could have changed. */
export function invalidateAdminCache(login?: string): void {
  if (!login) { cache.clear(); return; }
  const suffix = `:${login.toLowerCase()}`;
  for (const key of [...cache.keys()]) if (key.endsWith(suffix)) cache.delete(key);
}

/**
 * True when the user is a member of the admin team. Org ownership does not count.
 *
 * Membership is read with the App/system token rather than the caller's: a user
 * cannot necessarily see a team they do not belong to, and "cannot see it"
 * would otherwise be indistinguishable from "is not in it".
 */
export async function isControlHubAdmin(login: string, userToken?: string): Promise<boolean> {
  return !!(await adminVia(login, CONTROL_HUB_ADMIN_TEAM, userToken));
}

/**
 * Who may create, edit, run or delete AWS guardrails.
 *
 * **The Control Hub admin team counts.** That team means "everything in this
 * app", the AWS half included — `permissionsFor` has given them every AWS
 * permission since the exemption was added, and this legacy gate sits *in
 * front of* the permission gates on every AWS write route. Checking only
 * `AWS_ADMIN_TEAM` meant a Control Hub admin was refused before the permission
 * system was ever consulted, and told to join a team that is supposed to have
 * stopped mattering.
 *
 * `AWS_ADMIN_TEAM` is still honoured, so nobody who has access today loses it.
 * Removing that team is a separate decision, made on GitHub.
 */
export async function isAwsAdmin(login: string, userToken?: string): Promise<boolean> {
  if (await adminVia(login, CONTROL_HUB_ADMIN_TEAM, userToken)) return true;
  return !!(await adminVia(login, AWS_ADMIN_TEAM, userToken));
}

/** The same question, answered with the route rather than with a yes. */
export async function controlHubAdminVia(login: string, userToken?: string): Promise<AdminVia> {
  return adminVia(login, CONTROL_HUB_ADMIN_TEAM, userToken);
}

export async function awsAdminVia(login: string, userToken?: string): Promise<AdminVia> {
  // Same two-team answer as `isAwsAdmin`, so the route reported to the account
  // menu cannot disagree with the one the gates actually took.
  return (await adminVia(login, CONTROL_HUB_ADMIN_TEAM, userToken))
    ?? adminVia(login, AWS_ADMIN_TEAM, userToken);
}

/** Thrown when the answer is unknown, as opposed to "no". */
class Unanswerable extends Error {}

async function adminVia(login: string, team: string, userToken?: string): Promise<AdminVia> {
  const key = `${team}:${login.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.value;

  let value: AdminVia;
  try {
    value = await resolve(login, team, userToken);
  } catch (err) {
    // Not cached, and not an answer about this person.
    //
    // A denial from a broken App token used to be stored for the full TTL, so a
    // credential problem lasting a second locked the caller out of every admin
    // screen for a minute after it healed, and gave them a plain "you are not
    // an admin", which is a claim about them rather than about the app.
    if (err instanceof Unanswerable) return null;
    throw err;
  }

  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  return value;
}

async function resolve(login: string, team: string, userToken?: string): Promise<AdminVia> {
  const org = getOrg();

  /**
   * The App's token if there is one, otherwise the caller's own.
   *
   * The App's is preferred because it can see a team the caller is not in, and
   * "cannot see it" would otherwise be indistinguishable from "is not in it".
   *
   * But an account can legitimately have no App at all: an installation that
   * runs the AWS guardrails and deliberately holds no GitHub App key, so that
   * nothing about the GitHub organization lives there. Sign-in still happens
   * through the OAuth App, and its token carries `read:org`, enough to answer
   * this one question, because every caller here is asking about *themselves*.
   *
   * That narrowing is what makes the fallback safe: with the caller's token the
   * only membership readable is the caller's own, which is the only one being
   * asked about.
   */
  const token = getSystemToken() || userToken;
  if (!token) {
    console.warn(
      "[authorization] Neither a GitHub App token nor a caller token, so team " +
      "membership cannot be read, denying this check without caching it.",
    );
    throw new Unanswerable("no token of any kind");
  }
  const octokit: Octokit = createOctokit(token, "Signing in");

  /**
   * Organization owners no longer qualify.
   *
   * They used to, as a safety net: an empty, renamed or deleted team could
   * otherwise lock everybody out of the screen that would fix it. That net had
   * a cost nobody wanted — owning the GitHub organization silently conferred
   * every permission in this app, including the AWS ones, and a person removed
   * from the admin team kept full access with nothing on screen explaining
   * why.
   *
   * Membership of the admin team is now the only way in, deliberately. The
   * recovery path for a deleted team is GitHub: an owner can still recreate it
   * and add themselves, which is the same act, done where it is visible,
   * instead of a permanent exemption nobody can see.
   */

  try {
    const { data } = await octokit.rest.teams.getMembershipForUserInOrg({
      org,
      team_slug: team,
      username: login,
    });
    return data.state === "active" ? "team" : null;
  } catch (err: any) {
    // 404 is the normal "not a member" answer, and also what a missing team returns.
    if (err?.status !== 404) {
      console.warn(`[authorization] Team membership check failed for "${login}" in "${team}": ${err?.message ?? err}`);
    }
    return null;
  }
}
