import { createOctokit, getSystemToken, getOrg } from "../github/client";
import type { Subject } from "./evaluate";

/**
 * Who somebody is, as far as GitHub is concerned: the teams they are in, and
 * whether they own the organization.
 *
 * Both are read from GitHub rather than from the permissions file, and that is
 * not an implementation detail. Organization owners are exempt from every
 * permission check so that an empty or broken file cannot lock everybody out of
 * the screen that would fix it — and an exemption stored *in* the file would be
 * revocable by the same file it exists to survive.
 *
 * Two different tokens, on purpose. Organization ownership is read with the
 * **App token**, which can see a membership the caller might not. The caller's
 * **own token** reads their teams, because `listForAuthenticatedUser` answers
 * that in one paginated call where the App-token route would cost one call per
 * team in the organization — and because the only membership that token can
 * read is the caller's own, which is the only one being asked about.
 *
 * Cached for the same minute as the file. Failing to read yields *no* teams
 * rather than a remembered set, for the same reason the file has no cached
 * fallback: a membership that outlives its source is a grant nobody can revoke.
 */

const TTL_MS = 60_000;

interface Entry { at: number; subject: Subject }
const cache = new Map<string, Entry>();

export function forgetSubjects(login?: string): void {
  if (!login) { cache.clear(); return; }
  cache.delete(login.toLowerCase());
}

export async function subjectFor(login: string, userToken?: string, now = Date.now()): Promise<Subject> {
  const key = login.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;

  const subject: Subject = { login, teamSlugs: [], isOrgOwner: false };
  const token = getSystemToken() || userToken;
  if (!token) return subject;

  const octokit = createOctokit(token, "Permissions");
  const org = getOrg();

  try {
    const { data } = await octokit.rest.orgs.getMembershipForUser({ org, username: login });
    subject.isOrgOwner = data.role === "admin";
  } catch (err: any) {
    // A 404 is the ordinary "not a member" answer. Anything else is a question
    // we could not ask, and the safe answer to "are you an owner" is no.
    if ((err?.status ?? err?.response?.status) !== 404) {
      console.warn(`[permissions] Could not read org membership for "${login}":`, err?.message ?? err);
    }
  }

  /**
   * The caller's own teams, in one paginated call, using *their* token.
   *
   * The obvious alternative — list every team in the organization with the App
   * token and ask "is this person in it" for each — costs one GitHub call per
   * team, per person, per permission load. An organization with fifty teams
   * would spend fifty calls answering one question, on every request.
   *
   * `listForAuthenticatedUser` answers it in one. It needs the caller's token,
   * which is safe for exactly the reason `authorizationService` already relies
   * on: the only membership that token can read is the caller's own, and the
   * caller's own is the only one being asked about. Without a user token there
   * are no teams — fail closed, like everything else here.
   */
  if (userToken) {
    try {
      const asUser = createOctokit(userToken, "Permissions");
      const slugs: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await asUser.rest.teams.listForAuthenticatedUser({ per_page: 100, page });
        for (const team of data) {
          if (team.organization?.login?.toLowerCase() === org.toLowerCase()) slugs.push(team.slug);
        }
        if (data.length < 100) break;
      }
      subject.teamSlugs = slugs;
    } catch (err: any) {
      console.warn(`[permissions] Could not read teams for "${login}":`, err?.message ?? err);
    }
  }

  cache.set(key, { at: now, subject });
  return subject;
}
