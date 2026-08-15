/**
 * Renovate's pull requests, found by who opened them.
 *
 * Self-hosted Renovate raises PRs as a GitHub App, and every installation
 * names its own. There is no Renovate API to ask; the App's authorship is the
 * only marker, which is why the account name is configuration rather than a
 * constant here.
 *
 * Read through GitHub's search API rather than by walking repositories. Search
 * is metered in its own bucket (30 requests a minute) separate from the core
 * limit everything else here competes for, so this cannot slow down the
 * Dependabot sweep or the graph sync however often anyone opens the tab.
 */

/** Closed PRs are shown for this long after they close, then drop off. */
export const CLOSED_RETENTION_MONTHS = 3;

export interface RenovatePr {
  id: number;
  number: number;
  title: string;
  repo: string;
  url: string;
  state: "open" | "closed";
  /** True when a closed PR was merged rather than abandoned. */
  merged: boolean;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Days the PR has been open, or was open before closing. */
  ageDays: number;
}

/** The one search call this needs, injectable so tests need no GitHub. */
export type SearchIssues = (q: string, page: number) => Promise<{
  items: any[];
  incompleteResults?: boolean;
  totalCount?: number;
}>;

export function retentionCutoff(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - CLOSED_RETENTION_MONTHS);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The two queries.
 *
 * Every open PR regardless of age, and closed ones only inside the retention
 * window — which is what makes "closed PRs disappear after three months" a
 * filter rather than a stored expiry. GitHub keeps the PR forever; the app
 * simply stops asking for it.
 */
export function buildQueries(org: string, bot: string, now = new Date()): { open: string; closed: string } {
  const base = `is:pr org:${org} author:${bot}`;
  return {
    open: `${base} is:open`,
    closed: `${base} is:closed closed:>=${isoDate(retentionCutoff(now))}`,
  };
}

function dayDiff(from: string, to: string | null): number {
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/**
 * Search returns issues, not pull requests, so the repository has to come out
 * of the URL. `repository_url` is the API address of the repo the PR lives in;
 * its last two segments are owner and name.
 */
export function normalizePr(item: any): RenovatePr {
  const repoUrl: string = item?.repository_url ?? "";
  const parts = repoUrl.split("/").filter(Boolean);
  const repo = parts.length >= 2 ? parts.slice(-1)[0] : "unknown";

  const closedAt: string | null = item?.closed_at ?? null;
  const state: "open" | "closed" = item?.state === "closed" ? "closed" : "open";

  return {
    id: Number(item?.id ?? 0),
    number: Number(item?.number ?? 0),
    title: String(item?.title ?? "").slice(0, 300),
    repo,
    // html_url is the browser address. The app never merges or comments; this
    // link is the whole of its write story — it hands you to GitHub.
    url: String(item?.html_url ?? ""),
    state,
    // Search does not return a merged flag. A closed PR with a merge commit
    // recorded on the pull_request stub was merged; one without was dropped,
    // and telling those apart is most of what the list is read for.
    merged: state === "closed" && !!item?.pull_request?.merged_at,
    draft: !!item?.draft,
    createdAt: String(item?.created_at ?? ""),
    updatedAt: String(item?.updated_at ?? ""),
    closedAt,
    ageDays: dayDiff(String(item?.created_at ?? ""), closedAt),
  };
}

const PER_PAGE = 100;
/**
 * Search refuses to page past 1,000 results, so ten pages is the real ceiling
 * rather than a limit chosen here. Hitting it is reported instead of silently
 * returning a partial list — a truncated count read as a total is how "we have
 * 1,000 open PRs" becomes "we have exactly 1,000 open PRs" forever.
 */
const MAX_PAGES = 10;

async function collect(search: SearchIssues, q: string): Promise<{ prs: RenovatePr[]; truncated: boolean }> {
  const prs: RenovatePr[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items } = await search(q, page);
    if (!items?.length) return { prs, truncated: false };
    prs.push(...items.map(normalizePr));
    if (items.length < PER_PAGE) return { prs, truncated: false };
  }
  return { prs, truncated: true };
}

export interface RenovateResult {
  prs: RenovatePr[];
  truncated: boolean;
  /** Echoed back so the UI can say which account it looked for. */
  bot: string;
  /**
   * What actually matched, which may not be what was typed.
   *
   * Renovate self-hosted raises PRs as a GitHub App, and an App's login is
   * `<name>[bot]`. The name shown beside a pull request is the App's display
   * name without that suffix, so the obvious thing to type is the thing search
   * rejects.
   */
  resolvedBot?: string;
  /**
   * The configured account does not exist, or is not visible to this token.
   *
   * GitHub answers `author:` for an unknown user with 422 Validation Failed
   * rather than an empty result, so a typo in the bot name would otherwise
   * surface as a 500 and read as the feature being broken. Reported as its own
   * state because the fix is to correct the name, and no error message about
   * a failed search says that.
   */
  unknownBot?: boolean;
}

/**
 * The candidate logins for a name somebody typed.
 *
 * `author:` wants the exact login. A GitHub App's is `<name>[bot]`, and that
 * suffix is invisible in the GitHub UI — it shows the display name with a
 * separate "Bot" label beside it. So both are tried, App form first, because
 * an App is what raises these.
 */
export function botCandidates(bot: string): string[] {
  const trimmed = bot.trim();
  if (trimmed.endsWith("[bot]")) return [trimmed, trimmed.slice(0, -"[bot]".length)];
  return [`${trimmed}[bot]`, trimmed];
}

export async function fetchRenovatePrs(
  search: SearchIssues,
  org: string,
  bot: string,
  now = new Date(),
): Promise<RenovateResult> {
  // Search answers an unknown author with 422 rather than an empty result, so
  // an unrecognised name is a signal to try the other form rather than a
  // failure to report.
  let lastUnknown = true;
  for (const candidate of botCandidates(bot)) {
    const attempt = await fetchForExactLogin(search, org, candidate, now);
    if (!attempt.unknownBot) return { ...attempt, bot, resolvedBot: candidate };
    lastUnknown = true;
  }
  return { prs: [], truncated: false, bot, unknownBot: lastUnknown };
}

async function fetchForExactLogin(
  search: SearchIssues,
  org: string,
  bot: string,
  now: Date,
): Promise<RenovateResult> {
  const { open, closed } = buildQueries(org, bot, now);

  let o: { prs: RenovatePr[]; truncated: boolean };
  let c: { prs: RenovatePr[]; truncated: boolean };
  try {
    [o, c] = await Promise.all([collect(search, open), collect(search, closed)]);
  } catch (err: any) {
    if (err?.status === 422) return { prs: [], truncated: false, bot, unknownBot: true };
    throw err;
  }

  // Open first, then most recently closed. Someone opening this page is
  // looking for what still needs merging.
  const prs = [...o.prs, ...c.prs].sort((a, b) => {
    if (a.state !== b.state) return a.state === "open" ? -1 : 1;
    if (a.state === "open") return b.ageDays - a.ageDays;   // oldest open first
    return new Date(b.closedAt ?? 0).getTime() - new Date(a.closedAt ?? 0).getTime();
  });

  return { prs, truncated: o.truncated || c.truncated, bot };
}

/** Just the open ones — what the widget counts and the alarm watches. */
export function openPrs(prs: RenovatePr[]): RenovatePr[] {
  return prs.filter(p => p.state === "open");
}
