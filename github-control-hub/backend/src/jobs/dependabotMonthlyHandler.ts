import { createAppAuth } from "@octokit/auth-app";
import { initTokenManager, getSystemTokenAsync, createOctokit, getOrg } from "../github/client";
import { loadSecretsIntoEnv } from "../webhooks/secret";
import { runDependabotBulk } from "../services/dependabotBulk";
import { tick } from "../services/dependabotMonthly";
import { loadDependabotBatches, saveDependabotBatches } from "../services/orgConfigService";
import { logActivity } from "../services/activityService";

/**
 * The hourly pass that opens and closes each monthly Dependabot batch's window.
 *
 * Hourly rather than once a day so that a failed or missed invocation is
 * made up an hour later, and so that a window opened by hand ("Run now") is
 * closed within the hour of its end. Almost every pass reads one record and
 * does nothing; the ones that act are a batch's opening on its release day and
 * its closing 24 hours later. See services/dependabotMonthly.ts for the rules.
 *
 * Runs as the GitHub App, which needs Administration: write to flip the
 * switch. Without it every repository's result says so, and the Vulnerabilities
 * tab shows which ones are not getting fixes.
 *
 * The bootstrap mirrors the graph job's: App auth needs createAppAuth passed in
 * inside a bundle, and a bootstrap that failed to load secrets is not memoised.
 */

let bootstrapped: Promise<void> | null = null;

function bootstrapOnce(): Promise<void> {
  if (!bootstrapped) {
    bootstrapped = (async () => {
      await loadSecretsIntoEnv();
      if (!process.env.GITHUB_ORG) {
        bootstrapped = null;
        throw new Error("[DependabotMonthly] Secrets did not load. GITHUB_ORG is unset; not caching this bootstrap");
      }
      if (!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID)) {
        bootstrapped = null;
        throw new Error("[DependabotMonthly] No GitHub App credentials; nothing can be switched");
      }
      await initTokenManager(
        process.env.GITHUB_APP_ID,
        process.env.GITHUB_APP_PRIVATE_KEY,
        process.env.GITHUB_APP_INSTALLATION_ID,
        createAppAuth,
      );
    })();
  }
  return bootstrapped;
}

export async function handler(): Promise<{ acted: { id: string; did: string; failed: number }[] }> {
  await bootstrapOnce();
  const octokit = createOctokit(await getSystemTokenAsync(), "Monthly Dependabot security fixes");
  const org = getOrg();

  const acted = await tick({
    bulk: (repos, action) => runDependabotBulk(octokit, org, repos, action),
    load: loadDependabotBatches,
    save: saveDependabotBatches,
    log: (action, actor, repo, details) => logActivity(action, actor, repo, "Dependabot", details, undefined, "app"),
  });

  for (const a of acted) console.log(`[DependabotMonthly] ${a.id}: ${a.did}${a.failed ? `, ${a.failed} failed` : ""}`);
  // Failures are recorded on each batch and shown on the Vulnerabilities tab.
  // Not thrown: a retry would switch the ones that succeeded a second time, and
  // the next hourly pass is not the way to fix a missing permission.
  return { acted };
}
