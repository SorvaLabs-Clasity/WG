import { withSecondaryRetry } from "../utils/rateLimit";
import { clearDependabotPrCache } from "./dependabotPrs";

/**
 * Closing every open Dependabot pull request on chosen repositories.
 *
 * Not a tidy-up, whatever it looks like. GitHub treats a manual close exactly
 * as it treats the `@dependabot close` command, and **prevents Dependabot from
 * recreating that pull request**. So this suppresses fixes rather than
 * deferring them, per pull request rather than per repository, and undoing it
 * means reopening each one by hand or commenting `@dependabot reopen` on it.
 *
 * The screen says that before the button is pressed. This file's job is to make
 * sure the blast radius is exactly what was chosen and nothing more.
 */

/** One page of a GitHub issue search. */
type SearchPrs = (query: string) => Promise<{ repo: string; number: number; url?: string; title?: string }[]>;

export interface CloseFailure {
  repo: string;
  number: number;
  error: string;
}

export interface CloseSummary {
  /** How many were closed, in total. */
  closed: number;
  /** And per repository, which is the unit somebody selected in. */
  byRepo: Record<string, number>;
  failed: number;
  failures: CloseFailure[];
  /** Whole seconds spent waiting because GitHub asked us to. */
  sleptSeconds: number;
}

/**
 * Between writes. Closing pull requests in quick succession is precisely the
 * shape GitHub's secondary rate limit exists to refuse, and a run of eighty
 * that trips it halfway is worse than a slower one that finishes.
 */
const GAP_MS = 350;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function closeDependabotPrs(
  octokit: any,
  org: string,
  repos: string[],
  search: SearchPrs,
): Promise<CloseSummary> {
  const summary: CloseSummary = { closed: 0, byRepo: {}, failed: 0, failures: [], sleptSeconds: 0 };

  /**
   * Nothing selected closes nothing.
   *
   * Checked first and explicitly, because this is the one input where a bug is
   * unbounded: an empty selection read as "no filter" would close every
   * Dependabot pull request in the organization, and there is no undo for that
   * beyond reopening each one.
   */
  const chosen = new Set(repos.filter(Boolean));
  if (chosen.size === 0) return summary;

  // GitHub does the authorship filtering, which is the filtering that matters:
  // the config pull requests this same app opens are authored by the person
  // who pressed the button, not by Dependabot, so they are not in this set.
  const open = await search(`is:pr is:open org:${org} author:app/dependabot`);

  // And the repository filtering is ours, because the search is org-wide.
  const targets = open.filter(pr => chosen.has(pr.repo));

  for (const pr of targets) {
    try {
      await withSecondaryRetry(() => octokit.rest.pulls.update({
        owner: org, repo: pr.repo, pull_number: pr.number, state: "closed",
      }));
      summary.closed++;
      summary.byRepo[pr.repo] = (summary.byRepo[pr.repo] ?? 0) + 1;
    } catch (err: any) {
      // One pull request somebody cannot write to must not leave the other
      // thirty-nine untouched. Named rather than counted: a number cannot be
      // chased, and reopening is per pull request anyway.
      summary.failed++;
      summary.failures.push({
        repo: pr.repo,
        number: pr.number,
        error: err?.status === 403
          ? "You do not have write access to this repository."
          : err?.message ?? String(err),
      });
    }

    // Deliberate even on success: the limit that refuses these is about the
    // rate of writes, not their outcome.
    await sleep(GAP_MS);
  }

  // The pull request search is held for a minute. Without this the tab reports
  // the pull requests it has just closed as still open, which reads as the
  // close having silently failed.
  clearDependabotPrCache();

  return summary;
}
