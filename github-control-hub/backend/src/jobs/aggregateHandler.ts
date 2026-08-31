import { createAppAuth } from "@octokit/auth-app";
import { initTokenManager } from "../github/client";
import { loadSecretsIntoEnv } from "../webhooks/secret";
import { aggregateGraphData } from "./graphAggregator";
import { refreshLightEdges } from "./lightGraphRefresh";
import { getOrgConfig } from "../services/orgConfigService";
import { logSync, SCHEDULE_ACTOR } from "../services/activityService";
import { flushUsage } from "../services/githubUsageService";

/**
 * The scheduled rebuild of the access graph.
 *
 * Every screen showing who can reach what reads a stored snapshot of the
 * organization, teams, members, collaborators, repository permissions. That
 * snapshot was only ever rebuilt when somebody pressed a button, so a graph
 * built before a person joined, left, or was made an owner looked exactly like
 * a current one, and nothing on screen said how old it was.
 *
 * Six hours rather than minutes: the walk covers every repository, team and
 * member in the organization, so it is expensive in GitHub's rate limit and the
 * data it carries changes on the scale of days. A manual refresh exists for the
 * moments when six hours is too long, which is usually right after someone's
 * access has been changed and they want to see it.
 *
 * The bootstrap mirrors the alarm handler's, for the same reasons: App auth
 * needs createAppAuth passed in because require.resolve finds nothing inside a
 * bundle, and a bootstrap that failed to load secrets is not memoised, or the
 * container spends its whole life unable to reach GitHub.
 */

let bootstrapped: Promise<void> | null = null;

function bootstrapOnce(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await loadSecretsIntoEnv();

      if (!process.env.GITHUB_ORG) {
        bootstrapped = null;
        throw new Error("[GraphAggregator] Secrets did not load. GITHUB_ORG is unset; not caching this bootstrap");
      }

      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        await initTokenManager(
          process.env.GITHUB_APP_ID,
          process.env.GITHUB_APP_PRIVATE_KEY,
          process.env.GITHUB_APP_INSTALLATION_ID,
          createAppAuth,
        );
        console.log("[GraphAggregator] GitHub App token manager initialized");
      } else {
        bootstrapped = null;
        throw new Error("[GraphAggregator] No GitHub App credentials; nothing can be read");
      }
    })();
  }
  return bootstrapped;
}

/**
 * Two schedules, one function.
 *
 * `light` refreshes only the edges the expensive walk is otherwise the sole
 * writer of, repository metadata and team composition, for well under a
 * hundred requests. It runs often. The full rebuild stays on six hours.
 *
 * A second Lambda would have meant a second bundle, a second bootstrap and a
 * second set of permissions for a job that reads the same API with the same
 * token and writes the same table.
 */
export async function handler(event?: { mode?: "light" | "full" }): Promise<{ ok: boolean }> {
  await bootstrapOnce();

  if (event?.mode === "light") {
    const startedAt = Date.now();
    const r = await refreshLightEdges();
    console.log(
      `[GraphAggregator] light refresh: ${r.repos} repos, ${r.teams} teams, `
      + `${r.edgesWritten} written, ${r.edgesRemoved} removed, ${r.requests} requests`
      + (r.errors.length ? `, ${r.errors.length} errors` : ""),
    );

    // Logged only when it changed something or failed.
    //
    // This runs every half hour and the organization's shape does not change
    // that often, so recording every pass would bury the four daily rebuild
    // rows people actually look for under fifty saying nothing happened.
    if (r.edgesWritten > 0 && (r.edgesRemoved > 0 || r.errors.length > 0)) {
      await logSync("graph", SCHEDULE_ACTOR, {
        details: `Light refresh, ${r.repos} repositories, ${r.teams} teams, `
          + `${r.edgesRemoved} connections removed`,
        failed: r.errors.length > 0,
        error: r.errors.length ? r.errors.slice(0, 3).join("; ") : undefined,
        startedAt,
      });
    }
    await flushUsage();
    return { ok: true };
  }

  const startedAt = Date.now();

  // aggregateGraphData catches its own fatal errors and records them, so this
  // resolving is not a claim that the rebuild succeeded, the stored record is
  // where that is written, and the UI reads it from there.
  await aggregateGraphData();

  // Logged every run, unlike the five-minute jobs.
  //
  // Four rows a day is a legible history rather than noise, and this is the run
  // people ask about: every access and security screen reads what it collected,
  // so "when did this last happen and did it work" is the question behind almost
  // every report of a page showing stale or zero.
  //
  // Read back rather than assumed, because the walk swallows its own errors,
  // a row claiming success over a failed sync is worse than no row.
  const after = (await getOrgConfig()).graphAggregation;
  const failed = !!after?.lastError && (!after?.lastSuccessAt || !after.lastAttemptAt
    || Date.parse(after.lastAttemptAt) > Date.parse(after.lastSuccessAt));
  await logSync("graph", SCHEDULE_ACTOR, {
    details: failed
      ? "Scheduled sync failed"
      : `Scheduled sync from GitHub, ${after?.edgeCount ?? 0} connections`,
    failed,
    error: failed ? after?.lastError : undefined,
    startedAt,
  });

  await flushUsage();
  return { ok: true };
}
