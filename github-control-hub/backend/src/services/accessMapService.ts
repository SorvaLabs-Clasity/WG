import { scanGraphEdges } from "./graphService";

/**
 * Who can reach what, and by which route.
 *
 * The question an access review actually asks is not "who has admin" — it is
 * "if this person left tomorrow, what would they still be able to touch, and
 * where does each of those come from". Answering it needs the paths, not just
 * the outcome: revoking a direct grant does nothing if the person is also in a
 * team that owns the repository, and removing them from a team does nothing if
 * they are an organization owner.
 *
 * So every entry here carries every path we can derive, and says plainly when
 * the effective permission is more than the paths explain.
 *
 * One deliberate limit, stated everywhere it matters: read access is not in
 * the graph. Most organizations grant read on everything to every member by
 * default, which would be one edge per member per repository — hundreds of
 * thousands of rows saying the same thing. The map reports write and above,
 * and reports the organization's default separately so the omission is
 * visible rather than silent.
 */

export type OrgRole = "owner" | "member" | "outside_collaborator" | "unknown";

/** How someone came by their access to a repository. */
export interface AccessPath {
  via: "org_owner" | "team" | "direct";
  /** Team slug, for `via: "team"`. */
  team?: string;
  teamName?: string;
  /** What this path alone grants. */
  role: string;
}

export interface RepoAccess {
  repo: string;
  /** What GitHub says they can actually do — the strongest of all their paths. */
  role: string;
  paths: AccessPath[];
  archived?: boolean;
  visibility?: string;
}

export interface Person {
  login: string;
  orgRole: OrgRole;
  avatarUrl?: string;
  teams: { slug: string; name: string }[];
  /** Repositories they can write to or better. */
  repoCount: number;
  adminCount: number;
  /** Repos reachable only because of a grant made to them personally. */
  directCount: number;
  /** True when they are not a member of the organization. */
  outside: boolean;
}

export interface AccessMapSummary {
  people: Person[];
  org: {
    defaultRepositoryPermission: string;
    memberCount?: number;
    twoFactorRequirementEnabled?: boolean | null;
  };
  /** Repos in the graph, so the UI can browse the other direction. */
  repoCount: number;
  /** True when the graph has never been built with people in it. */
  stale: boolean;
}

/** admin > maintain > write > triage > read. Used to pick the strongest path. */
const RANK: Record<string, number> = { admin: 5, maintain: 4, write: 3, push: 3, triage: 2, read: 1, pull: 1 };
const strongest = (roles: string[]) =>
  roles.sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? "read";

interface Graph {
  edges: any[];
  /** login -> team slugs */
  teamsOf: Map<string, Set<string>>;
  /** team slug -> { repo -> permission } */
  teamRepos: Map<string, Map<string, string>>;
  teamNames: Map<string, string>;
  /** login -> { repo -> effective role } */
  effective: Map<string, Map<string, string>>;
  people: Map<string, { orgRole: OrgRole; avatarUrl?: string }>;
  repoMeta: Map<string, { archived?: boolean; visibility?: string }>;
  org: AccessMapSummary["org"];
  repos: Set<string>;
}

let cache: { at: number; graph: Graph } | null = null;
/** The graph is rebuilt on a schedule; re-deriving this on every click is waste. */
const CACHE_MS = 60_000;

const nameOf = (id: string) => id.slice(id.indexOf("#") + 1);

async function load(): Promise<Graph> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.graph;

  const edges = await scanGraphEdges();

  const g: Graph = {
    edges,
    teamsOf: new Map(),
    teamRepos: new Map(),
    teamNames: new Map(),
    effective: new Map(),
    people: new Map(),
    repoMeta: new Map(),
    org: { defaultRepositoryPermission: "unknown" },
    repos: new Set(),
  };

  for (const e of edges) {
    switch (e.type) {
      case "user_meta":
        g.people.set(nameOf(e.pk), {
          orgRole: (e.metadata?.orgRole as OrgRole) ?? "unknown",
          avatarUrl: e.metadata?.avatarUrl,
        });
        break;

      case "team_meta":
        g.teamNames.set(nameOf(e.pk), e.metadata?.name ?? nameOf(e.pk));
        break;

      case "org_meta":
        g.org = {
          defaultRepositoryPermission: e.metadata?.defaultRepositoryPermission ?? "unknown",
          memberCount: e.metadata?.memberCount,
          twoFactorRequirementEnabled: e.metadata?.twoFactorRequirementEnabled,
        };
        break;

      case "member_of": {
        const login = nameOf(e.pk);
        if (!g.teamsOf.has(login)) g.teamsOf.set(login, new Set());
        g.teamsOf.get(login)!.add(nameOf(e.sk));
        break;
      }

      case "owns_repo": {
        // TEAM# -> REPO#
        const team = nameOf(e.pk);
        const repo = nameOf(e.sk);
        if (!g.teamRepos.has(team)) g.teamRepos.set(team, new Map());
        g.teamRepos.get(team)!.set(repo, e.metadata?.permission ?? "read");
        g.repos.add(repo);
        break;
      }

      case "collaborates_on": {
        // USER# -> REPO#, carrying the effective role GitHub reports.
        const login = nameOf(e.pk);
        const repo = nameOf(e.sk);
        if (!g.effective.has(login)) g.effective.set(login, new Map());
        g.effective.get(login)!.set(repo, e.metadata?.role ?? "read");
        g.repos.add(repo);
        break;
      }

      case "repo_meta":
        g.repoMeta.set(nameOf(e.pk), {
          archived: e.metadata?.archived,
          visibility: e.metadata?.visibility,
        });
        g.repos.add(nameOf(e.pk));
        break;

      case "has_branch":
        g.repos.add(nameOf(e.pk));
        break;
    }
  }

  cache = { at: Date.now(), graph: g };
  return g;
}

/** Drop the derived view, so a fresh sync is visible immediately. */
export function invalidateAccessMap(): void {
  cache = null;
}

/**
 * Every repository one person can reach, with the route to each.
 *
 * Paths are derived rather than stored. GitHub's collaborator list reports one
 * effective permission per person per repository — the strongest thing they
 * can do — and says nothing about how many separate grants produce it. Team
 * membership and org ownership we know independently, so those paths are
 * reconstructed; anything the effective role has beyond what they explain can
 * only have come from a grant made to that person, which is what "direct"
 * means here.
 */
export async function accessForUser(login: string): Promise<{
  login: string;
  orgRole: OrgRole;
  avatarUrl?: string;
  teams: { slug: string; name: string }[];
  repos: RepoAccess[];
  /** Present when the person is not in the graph at all. */
  unknown?: boolean;
}> {
  const g = await load();
  const person = g.people.get(login);
  const teamSlugs = [...(g.teamsOf.get(login) ?? [])];
  const effective = g.effective.get(login) ?? new Map<string, string>();
  const isOwner = person?.orgRole === "owner";

  // Repositories reachable through a team, and what each team grants.
  const viaTeams = new Map<string, AccessPath[]>();
  for (const slug of teamSlugs) {
    for (const [repo, permission] of g.teamRepos.get(slug) ?? []) {
      if (!viaTeams.has(repo)) viaTeams.set(repo, []);
      viaTeams.get(repo)!.push({
        via: "team", team: slug, teamName: g.teamNames.get(slug) ?? slug, role: permission,
      });
    }
  }

  // An owner reaches every repository, whether or not a collaborator edge
  // exists for them on it. Listing only the ones GitHub happened to return
  // would understate the single broadest grant in the organization.
  const candidates = new Set<string>([
    ...effective.keys(),
    ...viaTeams.keys(),
    ...(isOwner ? g.repos : []),
  ]);

  const repos: RepoAccess[] = [];
  for (const repo of candidates) {
    const paths: AccessPath[] = [];
    if (isOwner) paths.push({ via: "org_owner", role: "admin" });
    paths.push(...(viaTeams.get(repo) ?? []));

    const explained = strongest(paths.map(p => p.role));
    const actual = effective.get(repo);

    // More than the paths explain means a grant to this person specifically.
    if (actual && (paths.length === 0 || (RANK[actual] ?? 0) > (RANK[explained] ?? 0))) {
      paths.push({ via: "direct", role: actual });
    }

    const meta = g.repoMeta.get(repo);
    repos.push({
      repo,
      role: actual ?? explained,
      paths,
      archived: meta?.archived,
      visibility: meta?.visibility,
    });
  }

  repos.sort((a, b) => (RANK[b.role] ?? 0) - (RANK[a.role] ?? 0) || a.repo.localeCompare(b.repo));

  return {
    login,
    orgRole: person?.orgRole ?? "unknown",
    avatarUrl: person?.avatarUrl,
    teams: teamSlugs.map(slug => ({ slug, name: g.teamNames.get(slug) ?? slug })).sort((a, b) => a.name.localeCompare(b.name)),
    repos,
    ...(person || teamSlugs.length || effective.size ? {} : { unknown: true }),
  };
}

/** The same question asked from the other end: who can reach this repository. */
export async function accessForRepo(repo: string): Promise<{
  repo: string;
  archived?: boolean;
  visibility?: string;
  people: (RepoAccess & { login: string; orgRole: OrgRole; outside: boolean })[];
  teams: { slug: string; name: string; permission: string; memberCount: number }[];
}> {
  const g = await load();

  const teams = [...g.teamRepos.entries()]
    .filter(([, repos]) => repos.has(repo))
    .map(([slug, repos]) => ({
      slug,
      name: g.teamNames.get(slug) ?? slug,
      permission: repos.get(repo)!,
      memberCount: [...g.teamsOf.values()].filter(set => set.has(slug)).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Everyone with any route to it: a collaborator edge, a team that owns it,
  // or organization ownership.
  const logins = new Set<string>();
  for (const [login, repos] of g.effective) if (repos.has(repo)) logins.add(login);
  for (const t of teams) {
    for (const [login, slugs] of g.teamsOf) if (slugs.has(t.slug)) logins.add(login);
  }
  for (const [login, p] of g.people) if (p.orgRole === "owner") logins.add(login);

  const people = await Promise.all([...logins].map(async login => {
    const person = g.people.get(login);
    const full = await accessForUser(login);
    const entry = full.repos.find(r => r.repo === repo);
    return {
      login,
      orgRole: person?.orgRole ?? "unknown" as OrgRole,
      outside: person?.orgRole === "outside_collaborator",
      repo,
      role: entry?.role ?? "read",
      paths: entry?.paths ?? [],
    };
  }));

  people.sort((a, b) => (RANK[b.role] ?? 0) - (RANK[a.role] ?? 0) || a.login.localeCompare(b.login));

  const meta = g.repoMeta.get(repo);
  return { repo, archived: meta?.archived, visibility: meta?.visibility, people, teams };
}

/** One row per person, enough to render the list without loading every detail. */
export async function accessSummary(): Promise<AccessMapSummary> {
  const g = await load();

  // Everyone the graph knows about, including people who appear only as a
  // collaborator or a team member — the member list can be incomplete, and a
  // person missing from an access review is the failure this exists to avoid.
  const logins = new Set<string>([
    ...g.people.keys(),
    ...g.effective.keys(),
    ...g.teamsOf.keys(),
  ]);

  const people: Person[] = [];
  for (const login of logins) {
    const detail = await accessForUser(login);
    const meta = g.people.get(login);
    people.push({
      login,
      orgRole: detail.orgRole,
      avatarUrl: meta?.avatarUrl,
      teams: detail.teams,
      repoCount: detail.repos.length,
      adminCount: detail.repos.filter(r => r.role === "admin").length,
      directCount: detail.repos.filter(r => r.paths.some(p => p.via === "direct")).length,
      outside: detail.orgRole === "outside_collaborator",
    });
  }

  people.sort((a, b) =>
    b.adminCount - a.adminCount || b.repoCount - a.repoCount || a.login.localeCompare(b.login));

  return {
    people,
    org: g.org,
    repoCount: g.repos.size,
    // No user_meta at all means the graph predates this feature. Reporting an
    // empty map would read as "nobody has access to anything".
    stale: g.people.size === 0,
  };
}

/** Repository names the graph knows, for the browse-by-repo direction. */
export async function knownRepos(): Promise<string[]> {
  const g = await load();
  return [...g.repos].sort();
}
