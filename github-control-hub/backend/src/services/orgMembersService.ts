/**
 * Everyone in the organization, for choosing a person rather than typing one.
 *
 * A free-text login box accepts anything, and "anything" includes real GitHub
 * accounts belonging to strangers — a typo does not fail, it silently names
 * somebody outside the organization who then shows up with their photograph
 * next to it. Muting a stranger is harmless but meaningless: it looks like the
 * mute was set, and the person actually being chased keeps getting reminded.
 *
 * So the list is fetched and the choice is made from it.
 */

export interface OrgMember {
  login: string;
  avatarUrl: string | null;
}

/** GitHub's maximum, and the only page size worth asking for. */
const PER_PAGE = 100;

/**
 * A ceiling, so an unexpected paging loop cannot spin forever. Fifty pages is
 * five thousand people — far past any organization this runs against, and
 * reached only if something is wrong.
 */
const MAX_PAGES = 50;

export interface MembersDeps {
  /** One page of members. Kept as a seam so paging is testable without a network. */
  listPage(org: string, page: number, perPage: number): Promise<Array<{
    login?: string; avatar_url?: string; type?: string;
  }>>;
}

export function depsFromOctokit(octokit: any): MembersDeps {
  return {
    listPage: async (org, page, per_page) => {
      const { data } = await octokit.rest.orgs.listMembers({ org, page, per_page });
      return data ?? [];
    },
  };
}

/**
 * Every member, across every page.
 *
 * Reading only the first page is the bug this shape exists to avoid: it returns
 * a hundred people and looks completely successful, so an organization of a
 * hundred and twenty has twenty people who cannot be picked and no sign that
 * anything is missing.
 */
export async function listOrgMembers(deps: MembersDeps, org: string): Promise<OrgMember[]> {
  const seen = new Set<string>();
  const members: OrgMember[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await deps.listPage(org, page, PER_PAGE);
    for (const m of batch) {
      const login = (m.login ?? "").trim();
      if (!login) continue;
      // Apps are not members, but an installation can surface as one on some
      // endpoints; a bot is never somebody to stop reminding.
      if (m.type === "Bot") continue;
      const key = login.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ login, avatarUrl: m.avatar_url ?? null });
    }
    // A short page is the last page. Asking for the next one costs a request
    // and returns nothing.
    if (batch.length < PER_PAGE) break;
  }

  return members.sort((a, b) => a.login.localeCompare(b.login, undefined, { sensitivity: "base" }));
}

/**
 * Whether a login belongs to the organization, compared the way GitHub does.
 *
 * Logins are case-insensitive, so refusing "Alice" because the list says
 * "alice" would reject a real member for a capital letter.
 */
export function isOrgMember(login: string, members: OrgMember[]): boolean {
  const k = (login ?? "").trim().toLowerCase();
  return !!k && members.some(m => m.login.trim().toLowerCase() === k);
}
