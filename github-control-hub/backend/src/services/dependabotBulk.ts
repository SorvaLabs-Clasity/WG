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

export type BulkAction = "alerts-on" | "alerts-off" | "fixes-on" | "fixes-off" | "retrigger";

export interface BulkResult {
  repo: string;
  ok: boolean;
  /** Present when this repository failed, in words a person can act on. */
  error?: string;
  /** True when the failure was GitHub asking us to slow down, after retries. */
  rateLimited?: boolean;
  /**
   * True when this repository now has security updates switched off.
   *
   * Distinct from an ordinary failure, which leaves the repository as it was.
   */
  leftOff?: boolean;
}

export interface BulkSummary {
  results: BulkResult[];
  changed: number;
  failed: number;
  /** Whole seconds the run spent waiting because GitHub asked it to. */
  sleptSeconds: number;
  /**
   * Repositories left with security updates switched off.
   *
   * Only "retrigger" can produce these, and it is the one outcome of this
   * whole file that leaves an organization worse than it found it: the switch
   * went off, and putting it back was refused for a reason waiting will not
   * fix. Counted and named separately from ordinary failures because it needs
   * a different response, immediately, on named repositories.
   */
  leftOff: number;
  leftOffRepos: string[];
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

/** More than MAX_ATTEMPTS: giving up here leaves a repository unprotected. */
const RESTORE_ATTEMPTS = 6;

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
    case "retrigger": {
      /**
       * Off, then straight back on.
       *
       * The documented way to make Dependabot revisit a backlog is a grouped
       * security-updates configuration on the default branch, which under
       * branch protection is a pull request and an approval per repository.
       * This asks for the same re-evaluation with two calls and no review.
       *
       * GitHub does not promise it works. It is worth trying because it is
       * free, and the caller is told as much before pressing it.
       */
      await octokit.rest.repos.disableAutomatedSecurityFixes(target);
      await sleep(GAP_MS);
      // Deliberately not left to the outer retry loop. That loop would start
      // the action again from the top, switching the repository off a second
      // time, and it gives up in the same place for the same reasons. Coming
      // back on is the half that must not be given up on.
      return void await restoreFixes(octokit, target);
    }
  }
}

/**
 * Put security updates back, and keep trying.
 *
 * Every refusal is retried, not only the ones GitHub asks us to wait out: the
 * alternative to trying again is a repository that silently stops receiving
 * security fixes. The error raised on giving up says so in those words,
 * because "403" at the end of a run of sixty-six is not something anybody can
 * act on.
 */
async function restoreFixes(octokit: any, target: { owner: string; repo: string }): Promise<void> {
  let last: any;
  for (let attempt = 0; attempt < RESTORE_ATTEMPTS; attempt++) {
    try {
      return void await octokit.rest.repos.enableAutomatedSecurityFixes(target);
    } catch (err: any) {
      last = err;
      if (attempt < RESTORE_ATTEMPTS - 1) await sleep(backoffMs(attempt, retryAfterOf(err)));
    }
  }
  throw Object.assign(
    new Error(
      `Security updates are now OFF on ${target.repo} and could not be turned back on: `
      + `${last?.message ?? last}. Turn them back on for this repository.`),
    { leftOff: true },
  );
}

/** GitHub's own retry-after, where it gave one. */
function retryAfterOf(err: any): number | undefined {
  const raw = Number(err?.response?.headers?.["retry-after"]);
  return Number.isFinite(raw) ? raw : undefined;
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
        // Checked before anything else, including the rate-limit handling: this
        // error already exhausted its own retries, and it carries the one
        // outcome somebody has to act on today.
        if (err?.leftOff) {
          return { repo, ok: false, leftOff: true, error: err.message };
        }
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
    leftOff: results.filter(r => r.leftOff).length,
    leftOffRepos: results.filter(r => r.leftOff).map(r => r.repo).sort(),
  };
}
