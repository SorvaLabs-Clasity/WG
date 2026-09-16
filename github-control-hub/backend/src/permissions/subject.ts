import { createOctokit, getSystemToken, getOrg } from "../github/client";
import type { Subject } from "./evaluate";
import { testHooks } from "./testing";

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
 * **`ownToken` is a token belonging to `login` itself.** Not an administrator's,
 * not the App's. `teams.listForAuthenticatedUser` is `GET /user/teams`: it takes
 * no username and answers for whoever holds the token, so nothing about that
 * call narrows it to the person being asked about. Handing it somebody else's
 * token returns *their* teams under this `login`, which is a grant nobody wrote
 * down — and the admin screen's dry-run diff is exactly the caller that would
 * do it, asking "what would this person hold?" while holding its own operator's
 * token. So the option is named for what it has to be, and the answer is cached
 * under how it was obtained as well as who it was about.
 *
 * Without an `ownToken` the teams are resolved with the **App token** instead,
 * which *can* be narrowed — `getMembershipForUserInOrg` takes a username — at
 * the cost of one call per team in the organization.
 *
 * Cached for the same minute as the file. Failing to read yields *no* teams
 * rather than a remembered set, for the same reason the file has no cached
 * fallback: a membership that outlives its source is a grant nobody can revoke.
 */

const TTL_MS = 60_000;

interface Entry { at: number; subject: Subject }

/**
 * Keyed by login **and** by how the teams were resolved.
 *
 * The two paths answer different questions — "what am I in", asked with the
 * person's own token, and "what is that person in", asked with the App's — and
 * the App path is the weaker of the two, since a team the App cannot see is a
 * team it will not report. Sharing one key would let a single administrative
 * inspection of somebody overwrite that person's own cached subject for the
 * rest of the minute, and they would spend it holding less than they should.
 */
const cache = new Map<string, Entry>();

const keyFor = (login: string, via: "self" | "app") => `${login.toLowerCase()}:${via}`;

export function forgetSubjects(login?: string): void {
  if (!login) { cache.clear(); return; }
  cache.delete(keyFor(login, "self"));
  cache.delete(keyFor(login, "app"));
}

export interface SubjectOptions {
  /**
   * A token belonging to `login` **itself** — the signed-in caller's own grant.
   *
   * Never pass one belonging to anybody else: `GET /user/teams` answers for the
   * token holder, so another person's token would attribute their teams to this
   * login. Omit it instead, and the App token answers about `login` by name.
   */
  ownToken?: string;
}

export async function subjectFor(login: string, opts?: SubjectOptions, now = Date.now()): Promise<Subject> {
  const ownToken = opts?.ownToken;
  const key = keyFor(login, ownToken ? "self" : "app");
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;

  const subject: Subject = { login, teamSlugs: [], isOrgOwner: false };

  /**
   * The test seam, consulted before any GitHub call — a test that installs
   * hooks must not need `GITHUB_ORG` or a network call to get an answer. Each
   * hook answers one of the three questions below independently; whatever a
   * hook leaves unanswered still falls through to the real GitHub calls
   * beneath it, so installing one hook does not require mocking every path.
   */
  const hooks = testHooks();
  const ownerHooked = hooks?.ownerOf !== undefined;
  if (ownerHooked) subject.isOrgOwner = hooks!.ownerOf!(login);

  const ownTeamsHooked = !!ownToken && hooks?.ownTeams !== undefined;
  const teamsOfHooked = !ownToken && hooks?.teamsOf !== undefined;
  let teamsResolved = false;
  if (ownTeamsHooked) {
    subject.teamSlugs = hooks!.ownTeams!(ownToken!);
    teamsResolved = true;
  } else if (teamsOfHooked) {
    subject.teamSlugs = hooks!.teamsOf!(login);
    teamsResolved = true;
  }

  if (ownerHooked && teamsResolved) {
    cache.set(key, { at: now, subject });
    return subject;
  }

  /**
   * Inside the try, deliberately. `getOrg()` throws when `GITHUB_ORG` is unset,
   * and a throw here is a fail-*OPEN* path rather than "a rejection with extra
   * steps": the caller treats a rejected promise differently from an answer,
   * and the answer to "who is this person" when we cannot ask is "nobody with
   * anything".
   */
  let org: string;
  let appToken: string;
  try {
    org = getOrg();
    appToken = getSystemToken();
  } catch (err: any) {
    console.warn(`[permissions] Could not read the subject for "${login}":`, err?.message ?? err);
    if (teamsResolved) cache.set(key, { at: now, subject });
    return subject;
  }

  if (!appToken && !ownToken) {
    if (teamsResolved) cache.set(key, { at: now, subject });
    return subject;
  }

  /**
   * Ownership, with the App token — and once more with the caller's own if the
   * App's attempt failed.
   *
   * The App token can see a membership the caller might not, so it goes first.
   * But `createOctokit` disables throttle retry, so a rate-limited App token
   * fails the file read and this one together — and the owner exemption exists
   * precisely for the minutes when everything else is broken. The caller's own
   * grant draws on a separate allowance, and GitHub narrows it for us because
   * `username` is passed, so the retry can only ever answer about `login`.
   */
  if (!ownerHooked) {
    const first = await readOwnership(appToken || ownToken!, org, login);
    if (first.answered) {
      subject.isOrgOwner = first.isOwner;
    } else if (ownToken && ownToken !== appToken) {
      const retry = await readOwnership(ownToken, org, login);
      if (retry.answered) subject.isOrgOwner = retry.isOwner;
    }
  }

  if (!teamsResolved) {
    try {
      if (ownToken) {
        subject.teamSlugs = await ownTeams(ownToken, org);
        teamsResolved = true;
      } else if (appToken) {
        subject.teamSlugs = await teamsOfSomebodyElse(appToken, org, login);
        teamsResolved = true;
      }
    } catch (err: any) {
      console.warn(`[permissions] Could not read teams for "${login}":`, err?.message ?? err);
    }
  }

  /**
   * Only an answer that was actually resolved is remembered. Caching an empty
   * list that nothing produced would let one tokenless internal call leave this
   * login holding nothing for the next minute, and the request that caused it
   * is not the request that pays for it.
   */
  if (teamsResolved) cache.set(key, { at: now, subject });
  return subject;
}

/**
 * Is this person an organization owner, and were we able to find out?
 *
 * The two are separate because a 404 is an answer — the ordinary "not a member"
 * — while anything else is a question we could not ask, and only the second is
 * worth spending a second token on.
 */
async function readOwnership(
  token: string, org: string, login: string,
): Promise<{ answered: boolean; isOwner: boolean }> {
  try {
    const octokit = createOctokit(token, "Permissions");
    const { data } = await octokit.rest.orgs.getMembershipForUser({ org, username: login });
    return { answered: true, isOwner: data.role === "admin" };
  } catch (err: any) {
    if ((err?.status ?? err?.response?.status) === 404) return { answered: true, isOwner: false };
    console.warn(`[permissions] Could not read org membership for "${login}":`, err?.message ?? err);
    return { answered: false, isOwner: false };
  }
}

/**
 * The caller's *own* teams, in one paginated call, using their own token.
 *
 * `GET /user/teams` takes no username: it answers for whoever holds the token,
 * which is why this function takes no login and why its caller must only ever
 * pass a token belonging to the person being asked about. That is also what
 * makes it cheap — one paginated call rather than one per team.
 */
async function ownTeams(ownToken: string, org: string): Promise<string[]> {
  const octokit = createOctokit(ownToken, "Permissions");
  const slugs: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await octokit.rest.teams.listForAuthenticatedUser({ per_page: 100, page });
    for (const team of data) {
      if (team.organization?.login?.toLowerCase() === org.toLowerCase()) slugs.push(team.slug);
    }
    if (data.length < 100) break;
  }
  return slugs;
}

/**
 * Somebody else's teams, with the App token: every team in the organization,
 * then one membership check each.
 *
 * This is O(teams) GitHub calls, and that is only acceptable because of who
 * asks. The per-request path always has the caller's own token and never comes
 * here; this is the rare administrative inspection — stage 4's "what would this
 * person hold?" — where the alternative is answering about the wrong person.
 * If it ever becomes a per-request cost, it is the wrong implementation.
 *
 * A failure anywhere throws rather than returning a short list: half the teams
 * is not a smaller answer, it is a wrong one, and the caller fails closed.
 */
async function teamsOfSomebodyElse(appToken: string, org: string, login: string): Promise<string[]> {
  const octokit = createOctokit(appToken, "Permissions");
  const slugs: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data } = await octokit.rest.teams.list({ org, per_page: 100, page });
    for (const team of data) {
      try {
        const { data: membership } = await octokit.rest.teams.getMembershipForUserInOrg({
          org, team_slug: team.slug, username: login,
        });
        // `pending` is an invitation nobody has accepted, which is not membership.
        if (membership.state === "active") slugs.push(team.slug);
      } catch (err: any) {
        if ((err?.status ?? err?.response?.status) !== 404) throw err;
      }
    }
    if (data.length < 100) break;
  }
  return slugs;
}
