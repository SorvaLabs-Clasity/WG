import { parseRateLimit } from "../utils/rateLimit";

/**
 * Turning Dependabot on or off across many repositories at once.
 *
 * The reason this is a service rather than a loop at the call site is pacing.
 * Doing it by hand, one repository at a time through the single-repo route, is
 * what produced "an unexpected error occurred": these are writes, GitHub
 * applies a **secondary** rate limit to writes made in quick succession, and
 * the app's client is built to surface those rather than retry them. A person
 * clicking down a list is a burst, and a burst is exactly what that limit is
 * for.
 *
 * So the work is spaced, kept to a few at a time, and backs off when GitHub
 * says to. It is slower than firing everything at once, and it finishes, which
 * the fast version did not.
 */

export type BulkAction = "alerts-on" | "alerts-off" | "fixes-on" | "fixes-off";

export interface BulkResult {
  repo: string;
  ok: boolean;
  /** Present when this repository failed, in words a person can act on. */
  error?: string;
  /** True when the failure was GitHub asking us to slow down, after retries. */
  rateLimited?: boolean;
}

export interface BulkSummary {
  results: BulkResult[];
  changed: number;
  failed: number;
  /** Whole seconds the run spent waiting because GitHub asked it to. */
  sleptSeconds: number;
}

/**
 * How many at once, and how far apart.
 *
 * Three is not a throughput choice. GitHub's guidance is to avoid concurrent
 * mutations and to leave a gap between them, and the numbers below are the
 * slowest that still feel like a bulk action: fifty repositories take about
 * twelve seconds rather than the fraction of a second that fails.
 */
const CONCURRENCY = 3;
const GAP_MS = 250;

/** Retries per repository, when GitHub asks for a pause rather than refusing. */
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The call each action makes.
 *
 * Alerts and fixes are two different switches on GitHub, and conflating them is
 * the mistake worth avoiding: alerts tell you a dependency is vulnerable, and
 * fixes are what opens the pull request that resolves it. Somebody asking for
 * the second almost always wants the first as well, which is why `fixes-on`
 * turns both on rather than failing on a repository where alerts are off.
 */
async function apply(octokit: any, org: string, repo: string, action: BulkAction): Promise<void> {
  const target = { owner: org, repo };
  switch (action) {
    case "alerts-on":
      return void await octokit.rest.repos.enableVulnerabilityAlerts(target);
    case "alerts-off":
      return void await octokit.rest.repos.disableVulnerabilityAlerts(target);
    case "fixes-on":
      // Alerts first: GitHub will not open security updates for a repository
      // that is not being scanned, and turning fixes on alone would report
      // success while nothing ever arrived.
      await octokit.rest.repos.enableVulnerabilityAlerts(target);
      await sleep(GAP_MS);
      return void await octokit.rest.repos.enableAutomatedSecurityFixes(target);
    case "fixes-off":
      return void await octokit.rest.repos.disableAutomatedSecurityFixes(target);
  }
}

/** How long to wait before trying this repository again. */
function backoffMs(attempt: number, retryAfter?: number): number {
  // GitHub's own number when it gives one, because it knows better than a
  // formula does. Capped so a long `retry-after` cannot hold a request open
  // past the point somebody has given up on the page.
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    return Math.min(20_000, Math.max(1_000, retryAfter * 1000));
  }
  return Math.min(8_000, 750 * 2 ** attempt);
}

export async function runDependabotBulk(
  octokit: any,
  org: string,
  repos: string[],
  action: BulkAction,
  opts: { onProgress?: (done: number, total: number) => void } = {},
): Promise<BulkSummary> {
  const queue = [...new Set(repos)];
  const results: BulkResult[] = [];
  let slept = 0;
  let done = 0;

  /**
   * One repository, with the pause GitHub asked for.
   *
   * A secondary limit is a request to wait, not a refusal, so it is retried.
   * Anything else is reported as it is: a repository somebody cannot administer
   * fails for a reason that will not change however long we wait, and retrying
   * it would only make the run longer and the message later.
   */
  async function one(repo: string): Promise<BulkResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await apply(octokit, org, repo, action);
        return { repo, ok: true };
      } catch (err: any) {
        const limit = parseRateLimit(err);
        if (limit?.kind === "secondary" && attempt < MAX_ATTEMPTS - 1) {
          const wait = backoffMs(attempt, limit.retryAfter);
          slept += Math.round(wait / 1000);
          await sleep(wait);
          continue;
        }
        if (limit) {
          return {
            repo, ok: false, rateLimited: true,
            error: limit.kind === "secondary"
              ? "GitHub is still asking us to slow down. Try this one again in a minute."
              : "GitHub's hourly budget for this account is spent.",
          };
        }
        // 403 from a repository somebody does not administer is the common
        // case, and saying which repository is the whole value of the row.
        return {
          repo, ok: false,
          error: err?.status === 403
            ? "You do not have admin access to this repository."
            : err?.status === 404
              ? "Not found, or not visible to your account."
              : err?.message || "Failed",
        };
      }
    }
    return { repo, ok: false, error: "Gave up after several attempts" };
  }

  // A few at a time, each worker pausing between repositories. Concurrency and
  // the gap do different jobs: one bounds how many are in flight, the other
  // stops a single worker from becoming a burst on its own.
  async function worker(): Promise<void> {
    for (;;) {
      const repo = queue.shift();
      if (!repo) return;
      results.push(await one(repo));
      done++;
      opts.onProgress?.(done, repos.length);
      if (queue.length > 0) await sleep(GAP_MS);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return {
    results: results.sort((a, b) => a.repo.localeCompare(b.repo)),
    changed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    sleptSeconds: slept,
  };
}
