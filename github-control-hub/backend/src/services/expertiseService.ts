/**
 * Who knows this.
 *
 * Answers "if this breaks at 3am, who do I wake" for a repository, a path
 * inside one, or a library used across the organization.
 *
 * Everything here is on demand. There is no sync and nothing stored: an
 * incident question asked twice a month does not justify a nightly job over
 * every repository, and a stored answer would be stale exactly when it matters.
 *
 * Three signals, because one is misleading on its own:
 *
 *   commits   who changed it. Strongest signal, and the one that goes stale
 *             fastest — somebody who owned a file two years ago may have
 *             forgotten it, and somebody with four commits last week has it in
 *             their head right now.
 *   reviews   who read it. A reviewer who never commits still knows the code,
 *             and on teams that require review this is often the person with
 *             the fullest picture.
 *   comments  who discussed it. Weakest, and included because it catches the
 *             person who argued about a design without touching the file.
 *
 * Recency is applied per event rather than to the total, so ten commits last
 * week outrank two hundred from three years ago.
 */

export type Signal = "commit" | "review" | "comment";

export interface Contribution {
  login: string;
  signal: Signal;
  at: string;
}

export interface ExpertRow {
  login: string;
  score: number;
  commits: number;
  reviews: number;
  comments: number;
  /** ISO timestamp of their most recent contribution of any kind. */
  lastActive: string | null;
  /** Days since that, for the UI to say "3 days ago" without recomputing. */
  daysSinceActive: number | null;
}

/**
 * What each signal is worth before decay.
 *
 * A review is deliberately close to a commit. The instinct is to rank authors
 * far above reviewers, but during an incident the person who reviewed the
 * change that broke it is frequently the fastest to recognise it.
 */
export const SIGNAL_WEIGHT: Record<Signal, number> = {
  commit: 1.0,
  review: 0.7,
  comment: 0.25,
};

/**
 * Halving every 90 days.
 *
 * Chosen so a quarter-old contribution counts half, and a year-old one about a
 * sixteenth — still present, so a long-departed owner does not vanish entirely
 * from a list whose whole purpose is finding whoever knows the thing.
 */
export const HALF_LIFE_DAYS = 90;

/**
 * How many manifest searches one library question may cost.
 *
 * Code search has its own rate limit of thirty a minute, far smaller than the
 * rest of the API, so a lookup that walked every ecosystem would spend a third
 * of a minute's budget answering one question.
 */
export const MAX_LIBRARY_SEARCHES = 4;

export function decay(at: string, now: number): number {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return 0;
  // A timestamp in the future is a clock problem, not extra credit.
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.pow(0.5, days / HALF_LIFE_DAYS);
}

/**
 * Accounts that are not people.
 *
 * A bot with four thousand commits would otherwise top every list and push the
 * humans off it, which is the one outcome that makes this feature useless.
 */
export function isBot(login: string): boolean {
  const l = login.trim().toLowerCase();
  if (!l) return false;
  if (l.endsWith("[bot]") || l === "web-flow") return true;
  if (l === "github-actions" || l === "dependabot" || l === "renovate") return true;

  // "Bot" as a whole word, anywhere.
  //
  // A commit with no linked GitHub account falls back to the git config name,
  // which is a display name rather than a login — "Acme Studios Bot", not
  // "acme-bot[bot]". Matching only the login forms let exactly that account
  // rank first on a live lookup, which is the one result that makes this
  // feature worse than useless.
  //
  // Word-boundary matched on purpose: "Abbot", "Botha" and "Robotics" are
  // people and companies, and excluding them would silently drop humans.
  return /\bbots?\b/.test(l);
}

export function rankExperts(
  contributions: Contribution[],
  now = Date.now(),
  limit = 10,
): ExpertRow[] {
  const by = new Map<string, ExpertRow & { raw: number }>();

  for (const c of contributions) {
    if (!c.login || isBot(c.login)) continue;
    const row = by.get(c.login) ?? {
      login: c.login, score: 0, commits: 0, reviews: 0, comments: 0,
      lastActive: null, daysSinceActive: null, raw: 0,
    };
    if (c.signal === "commit") row.commits++;
    else if (c.signal === "review") row.reviews++;
    else row.comments++;

    row.raw += SIGNAL_WEIGHT[c.signal] * decay(c.at, now);
    if (!row.lastActive || c.at > row.lastActive) row.lastActive = c.at;
    by.set(c.login, row);
  }

  const rows = [...by.values()];
  if (rows.length === 0) return [];

  // Normalised to 100 against the top scorer rather than to an absolute scale.
  // The question is who to ask first, not how expert anyone is in the abstract,
  // and an absolute scale would read as "nobody here knows it" on a quiet repo.
  const top = Math.max(...rows.map(r => r.raw));
  for (const r of rows) {
    r.score = top > 0 ? Math.round((r.raw / top) * 100) : 0;
    r.daysSinceActive = r.lastActive
      ? Math.floor((now - new Date(r.lastActive).getTime()) / 86_400_000)
      : null;
  }

  return rows
    .sort((a, b) => b.raw - a.raw || a.login.localeCompare(b.login))
    .slice(0, limit)
    .map(({ raw, ...rest }) => rest);
}

/**
 * The manifest files worth reading to decide who touched a dependency.
 *
 * Lockfiles are deliberately absent. They change on every unrelated update, so
 * whoever last ran an install would rank as the expert on every library in the
 * project.
 */
export const MANIFESTS = [
  "package.json", "requirements.txt", "pyproject.toml", "Gemfile",
  "go.mod", "pom.xml", "build.gradle", "Cargo.toml", "composer.json",
  "*.csproj",
];

export function isManifest(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  return MANIFESTS.some(m =>
    m.startsWith("*") ? base.endsWith(m.slice(1)) : base === m);
}

// ── gathering the signals ─────────────────────────────────────────────
//
// Call budget is the whole design constraint. A per-pull-request review fetch
// is one request per pull request, so a repository with 200 of them costs 200
// requests to answer one question. The repository-wide comment endpoints return
// the same authorship in a single page each, which is why they are used instead.
//
//   repo lookup   3 requests  (commits, review comments, issue comments)
//   path lookup   1 request   (commits filtered by path)
//   library       1 search + up to N manifest-history requests

export interface GithubReader {
  listCommits: (repo: string, path?: string) => Promise<Array<{ login?: string; at?: string }>>;
  listReviewComments: (repo: string) => Promise<Array<{ login?: string; at?: string }>>;
  listIssueComments: (repo: string) => Promise<Array<{ login?: string; at?: string }>>;
  searchCode: (query: string) => Promise<Array<{ repo: string; path: string }>>;
}

/**
 * Whether a commit listing hit its page limit.
 *
 * GitHub returns one page and a `next` link; asking for a hundred and getting a
 * hundred means "at least a hundred", not "a hundred". Reporting the page size
 * as a count is a number that is wrong in a way nobody can see — a repository
 * with four thousand commits and one with a hundred and one both read as 100.
 *
 * Rather than paging to the end — forty requests for a busy repository, for a
 * number that changes nothing about the ranking — the count is reported as a
 * floor and the answer says so.
 */
export const COMMIT_PAGE = 100;

export function wasTruncated(rows: unknown[]): boolean {
  return rows.length >= COMMIT_PAGE;
}

const toContributions = (
  rows: Array<{ login?: string; at?: string }>,
  signal: Signal,
): Contribution[] =>
  rows
    .filter(r => r.login && r.at)
    .map(r => ({ login: r.login!, signal, at: r.at! }));

export async function expertsForRepo(
  gh: GithubReader,
  repo: string,
  now = Date.now(),
): Promise<{ experts: ExpertRow[]; degraded: string[]; sampled: boolean }> {
  const degraded: string[] = [];
  const safe = async <T>(what: string, fn: () => Promise<T[]>): Promise<T[]> => {
    try { return await fn(); } catch { degraded.push(what); return []; }
  };

  // In parallel: three independent reads, and one failing must not lose the
  // other two. A repository with issues disabled 404s on issue comments, which
  // would otherwise take the whole answer down.
  const [commits, reviews, comments] = await Promise.all([
    safe("commits", () => gh.listCommits(repo)),
    safe("reviews", () => gh.listReviewComments(repo)),
    safe("comments", () => gh.listIssueComments(repo)),
  ]);

  return {
    experts: rankExperts([
      ...toContributions(commits, "commit"),
      ...toContributions(reviews, "review"),
      ...toContributions(comments, "comment"),
    ], now),
    degraded,
    // Any of the three hitting its page limit makes every count a floor.
    sampled: wasTruncated(commits) || wasTruncated(reviews) || wasTruncated(comments),
  };
}

export async function expertsForPath(
  gh: GithubReader,
  repo: string,
  path: string,
  now = Date.now(),
): Promise<{ experts: ExpertRow[]; degraded: string[]; sampled: boolean }> {
  // Commits only. Review and comment endpoints cannot be filtered by path, and
  // attributing every review in the repository to one file would rank people
  // who never looked at it.
  try {
    const commits = await gh.listCommits(repo, path);
    return {
      experts: rankExperts(toContributions(commits, "commit"), now),
      degraded: [],
      sampled: wasTruncated(commits),
    };
  } catch {
    return { experts: [], degraded: ["commits"], sampled: false };
  }
}

/**
 * Who has touched a dependency, across the organization.
 *
 * Found by locating the manifests that name it and reading their history,
 * rather than by searching commit messages. A commit message search finds
 * whoever wrote the word, which is mostly bots and mostly wrong; the manifest
 * history finds whoever actually added, bumped or removed the dependency.
 */
export async function expertsForLibrary(
  gh: GithubReader,
  org: string,
  library: string,
  now = Date.now(),
  maxRepos = 12,
): Promise<{ experts: ExpertRow[]; repos: string[]; degraded: string[]; sampled: boolean }> {
  const degraded: string[] = [];

  // Scoped by filename, not `in:file`.
  //
  // A bare `"react" org:X in:file` search returns every source file mentioning
  // the word — nearly five thousand on a real organization, of which the first
  // page contained no manifests at all, so the whole lookup returned nothing.
  // `filename:package.json` returns only manifests and answers the question
  // actually being asked.
  //
  // One search per ecosystem, stopping as soon as there are enough
  // repositories. Most organizations are one or two ecosystems, so this is
  // usually a single search; the cap is what stops a miss from walking the
  // whole list against a rate limit of thirty a minute.
  const seen = new Set<string>();
  const targets: Array<{ repo: string; path: string }> = [];
  let searched = 0;

  for (const manifest of MANIFESTS) {
    if (targets.length >= maxRepos || searched >= MAX_LIBRARY_SEARCHES) break;
    // Globs cannot be used with filename:, and the ecosystems behind them are
    // covered by the named manifests above.
    if (manifest.startsWith("*")) continue;
    searched++;
    let hits: Array<{ repo: string; path: string }> = [];
    try {
      hits = await gh.searchCode(`"${library}" org:${org} filename:${manifest}`);
    } catch {
      degraded.push(`search:${manifest}`);
      continue;
    }
    for (const h of hits) {
      if (!isManifest(h.path) || seen.has(h.repo)) continue;
      seen.add(h.repo);
      targets.push(h);
      if (targets.length >= maxRepos) break;
    }
  }

  if (searched > 0 && degraded.length === searched) {
    return { experts: [], repos: [], degraded: ["search"], sampled: false };
  }

  if (targets.length === 0) {
    return { experts: [], repos: [], degraded, sampled: false };
  }

  const perRepo = await Promise.all(targets.map(async t => {
    try { return toContributions(await gh.listCommits(t.repo, t.path), "commit"); }
    catch { degraded.push(t.repo); return []; }
  }));

  return {
    experts: rankExperts(perRepo.flat(), now),
    repos: targets.map(t => t.repo),
    degraded,
    sampled: perRepo.some(wasTruncated),
  };
}
