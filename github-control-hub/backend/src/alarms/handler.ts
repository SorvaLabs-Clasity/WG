import { createAppAuth } from "@octokit/auth-app";
import { initTokenManager, getSystemTokenAsync, createOctokit } from "../github/client";
import { loadSecretsIntoEnv } from "../webhooks/secret";
import { evaluateAlarms } from "./evaluate";
import { computeWidgetRows } from "./widgetValues";
import { fetchOrgDependencyAlerts } from "../services/dependencyService";
import { evaluateSecurityQuery } from "../services/graphService";
import { fetchRenovatePrs, openPrs } from "../services/renovateService";
import { getOrgConfig } from "../services/orgConfigService";
import { listAlarms, getGroup, saveAlarmRuntime, getSecuritySettings } from "../services/alarmService";
import { getWidget } from "../services/widgetService";
import { publish } from "../services/notifyService";

/**
 * The scheduled half of alarms.
 *
 * Runs every fifteen minutes and evaluates whichever alarms are due. Nothing
 * on the internet can reach it; EventBridge is its only trigger.
 *
 * The bootstrap mirrors the webhook worker's, including the reasons: App auth
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
        throw new Error("[Alarm] Secrets did not load — GITHUB_ORG is unset; not caching this bootstrap");
      }

      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        try {
          await initTokenManager(
            process.env.GITHUB_APP_ID,
            process.env.GITHUB_APP_PRIVATE_KEY,
            process.env.GITHUB_APP_INSTALLATION_ID,
            createAppAuth,
          );
          console.log("[Alarm] GitHub App token manager initialized");
        } catch (err) {
          console.error("[Alarm] GitHub App token manager failed to initialize:", (err as Error).message);
        }
      }
    })();
  }
  return bootstrapped;
}

export async function handler(): Promise<void> {
  await bootstrapOnce();

  let token: string;
  try {
    token = await getSystemTokenAsync();
  } catch (err) {
    console.error(
      "[Alarm] Token resolution failed — degrading to SYSTEM_GITHUB_TOKEN for this run:",
      (err as Error).message,
    );
    token = process.env.SYSTEM_GITHUB_TOKEN || "";
  }

  const org = process.env.GITHUB_ORG!;
  const octokit = createOctokit(token);

  /**
   * Fetched at most once per run, however many alarms read it.
   *
   * Several Dependabot alarms are normal — one for criticals, one for highs —
   * and each doing its own org-wide sweep would multiply the request cost by
   * the number of alarms for identical data. Memoised on the promise so
   * concurrent reads share one call rather than racing.
   */
  let dependencyPromise: ReturnType<typeof fetchOrgDependencyAlerts> | null = null;
  const dependencyAlerts = () => {
    if (!dependencyPromise) dependencyPromise = fetchOrgDependencyAlerts(octokit, org);
    return dependencyPromise;
  };

  /**
   * Fetched at most once per run, like the Dependabot sweep above and for the
   * same reason: several alarms on the same number should cost one search, not
   * one each.
   */
  let renovatePromise: Promise<any[] | null> | null = null;
  const renovateOpenPrs = () => {
    if (!renovatePromise) {
      renovatePromise = (async () => {
        const bot = (await getOrgConfig()).renovateBot;
        if (!bot) return null;
        const res = await fetchRenovatePrs(
          async (q, page) => {
            const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
              q, per_page: 100, page, advanced_search: "true",
            });
            return { items: r.data?.items ?? [] };
          },
          org, bot,
        );
        // An unreachable bot is no reading at all. Returning zero would let
        // an alarm on "open PRs" resolve itself because the account name is
        // wrong, which is the opposite of what it is watching for.
        if (res.unknownBot) return null;
        return openPrs(res.prs);
      })();
    }
    return renovatePromise;
  };

  const sources = {
    dependencyAlerts,
    renovateOpenPrs,
    runQuery: (queryId: string, param?: string, advanced?: any) =>
      evaluateSecurityQuery(queryId, param, advanced, token) as Promise<any[]>,
  };

  const summary = await evaluateAlarms({
    now: Date.now(),
    org,
    timezone: (await getSecuritySettings()).timezone,
    listAlarms,
    getWidget: (id: string) => getWidget(id) as any,
    topicArnFor: async (groupId: string) => (await getGroup(groupId))?.topicArn,
    computeRows: (widget) => computeWidgetRows(widget, sources),
    publish,
    saveRuntime: saveAlarmRuntime,
  });

  console.log(
    `[Alarm] ${summary.evaluated} evaluated of ${summary.considered} enabled ` +
    `(${summary.skippedNotDue} not due), ${summary.fired} fired, ` +
    `${summary.recovered} recovered, ${summary.unreadable} unreadable, ` +
    `${summary.publishFailures} publish failures`,
  );

  // Deliberately not thrown. A publish failure is already logged and counted,
  // and failing the invocation would only make EventBridge retry the whole
  // pass — re-reading every widget and re-sending whatever did succeed.
}
