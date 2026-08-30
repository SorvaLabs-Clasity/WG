import { createAppAuth } from "@octokit/auth-app";
import { initTokenManager, getSystemTokenAsync, createOctokit } from "../github/client";
import { loadSecretsIntoEnv } from "../webhooks/secret";
import { evaluateAlarms } from "./evaluate";
import { computeWidgetRows } from "./widgetValues";
import { fetchOrgDependencyAlerts } from "../services/dependencyService";
import { evaluateSecurityQuery } from "../services/graphService";
import { fetchRenovatePrs, openPrs } from "../services/renovateService";
import { flushPending } from "./feedNotify";
import { runNudgePass } from "../services/prNudgeService";
import { GUARDRAIL_PREFIX, guardrailRuleOf } from "./conditions";
import { listGuardrails } from "../aws-guardrails/store";
import { getOrgConfig } from "../services/orgConfigService";
import { logSync, SCHEDULE_ACTOR } from "../services/activityService";
import {
  listAlarms, getGroup, saveAlarmRuntime, getSecuritySettings,
  getFeedSettings, listPending, markPendingSent,
  getPrState, recordNudge, touchPrState, getPrSettings, getPrMutes,
} from "../services/alarmService";
import { getWidget } from "../services/widgetService";
import { publish } from "../services/notifyService";

/**
 * The scheduled half of alarms.
 *
 * Runs every five minutes, evaluates whichever alarms are due, and flushes the
 * buffered per-repository notifications. Nothing on the internet can reach it;
 * EventBridge is its only trigger.
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
        throw new Error("[Alarm] Secrets did not load. GITHUB_ORG is unset; not caching this bootstrap");
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
  const startedAt = Date.now();
  await bootstrapOnce();

  // ── the developers' own digests ───────────────────────────────────
  //
  // First, not last. It used to run at the end of the pass, behind alarm
  // evaluation, the widget snapshots, a GraphQL walk of every open pull request
  // and the reminder pass. None of that is quick on a real organization, so a
  // summary somebody asked for at 11:45 arrived at 11:48 and read as the
  // schedule being approximate.
  //
  // Nothing here depends on any of it. The digest reads the pull request
  // snapshot the *previous* pass stored, which is at most five minutes old, and
  // five minutes of staleness in a daily summary is not worth three minutes of
  // lateness in delivering it.
  //
  // Still wrapped: one person's broken address must not stop the alarms.
  try {
    const { runDigestPass } = await import("./devDigest");
    const digests = await runDigestPass();
    if (digests.sent > 0 || digests.failed > 0) {
      console.log(`[DevDigest] ${digests.sent} sent, ${digests.skipped} skipped, ${digests.failed} failed`);
    }
  } catch (err) {
    console.error("[DevDigest] Digest pass failed:", (err as Error).message);
  }

  // No fallback. This used to degrade to a SYSTEM_GITHUB_TOKEN personal access
  // token, which meant a broken App produced alarm runs that quietly worked,
  // on a credential nobody remembered configuring, until that expired too.
  //
  // The App is the only credential now, so a run that cannot get a token fails
  // and says why. A failed scheduled run is visible in the function's logs and
  // its DLQ; a run that silently used a different identity is not.
  const token = await getSystemTokenAsync();

  const org = process.env.GITHUB_ORG!;
  const octokit = createOctokit(token);

  /**
   * Fetched at most once per run, however many alarms read it.
   *
   * Several Dependabot alarms are normal, one for criticals, one for highs,
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

  /**
   * One evaluation per distinct query per pass, however many alarms want it.
   *
   * The Dependabot sweep and the Renovate search are already memoised above for
   * exactly this reason and this was not, so three alarms on one query widget
   * re-ran it three times. That is wasted for most checks and expensive for one:
   * `dormant-privileged-users` costs a commit search per privileged account, and
   * commit search allows thirty requests a *minute*, so the duplication is drawn
   * against the smallest budget in the app.
   *
   * The promise is cached, not the result, so concurrent callers wait on the
   * same request rather than starting a second one. Rejections are cached too,
   * deliberately: a failed read should be reported once per pass, not retried
   * once per alarm watching it.
   */
  const queryRuns = new Map<string, Promise<any[]>>();
  const sources = {
    dependencyAlerts,
    renovateOpenPrs,
    runQuery: (queryId: string, param?: string, advanced?: any) => {
      const key = JSON.stringify([queryId, param ?? null, advanced ?? null]);
      let run = queryRuns.get(key);
      if (!run) {
        run = evaluateSecurityQuery(queryId, param, advanced, token) as Promise<any[]>;
        queryRuns.set(key, run);
      }
      return run;
    },
  };

  const summary = await evaluateAlarms({
    now: Date.now(),
    org,
    timezone: (await getSecuritySettings()).timezone,
    listAlarms,
    // A guardrail alarm has no widget. Its subject is synthesised from the id
    // it carries, which is what lets the evaluator stay entirely ignorant of
    // there being more than one kind of thing to watch.
    getWidget: async (id: string) => {
      if (id.startsWith(GUARDRAIL_PREFIX)) {
        const rule = guardrailRuleOf(id);
        const name = rule
          ? (await listGuardrails()).find(r => r.id === rule)?.name
          : undefined;
        return {
          id, type: "guardrail",
          title: rule ? `Guardrail: ${name ?? rule}` : "AWS guardrails",
        } as any;
      }
      return (await getWidget(id)) as any;
    },
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

  // ── the dashboard's snapshots ───────────────────────────────────────
  //
  // Every widget, not only the ones an alarm watches. This is the same
  // `computeWidgetRows` the alarm evaluation just used, drawing on the same
  // memoised sources, so a widget that already ran above is served from the
  // cached promise rather than run twice, and only the unwatched ones cost
  // anything extra.
  //
  // Sequential, deliberately. Running them at once would fire every live GitHub
  // call in the same instant, and the subject-by-subject checks draw on commit
  // search, which allows thirty requests a minute. The pass has five minutes and
  // nothing waiting on it.
  try {
    const { listWidgets } = await import("../services/widgetService");
    const { saveWidgetSnapshot } = await import("../services/alarmService");
    const all = await listWidgets();

    // One count for the whole pass, from the edges already in memory. This is
    // the denominator every repository-scoped card divides by, and reading it
    // here means the stored answer is complete when the dashboard opens.
    const { scanGraphEdges } = await import("../services/graphService");
    const repoTotal = await scanGraphEdges()
      .then(edges => edges.filter((e: any) => e.type === "repo_meta").length)
      .catch(() => null);

    let stored = 0, failed = 0;
    for (const widget of all) {
      try {
        const result = await computeWidgetRows(widget as any, sources);
        await saveWidgetSnapshot(widget.id, result, repoTotal);
        stored++;
      } catch (err: any) {
        // One widget that cannot be read must not cost the other twenty their
        // snapshot. The error is stored with it, so the card can say so rather
        // than showing a stale number as though it were current.
        failed++;
        await saveWidgetSnapshot(widget.id, {
          rows: null,
          error: err?.message ?? String(err),
        }).catch(() => { /* nothing further to do for this one */ });
      }
    }
    console.log(`[Alarm] widget snapshots: ${stored} stored, ${failed} unreadable of ${all.length}`);
  } catch (err) {
    // The snapshots are an optimisation; the dashboard falls back to computing
    // live without them. A failure here must not fail the alarm pass.
    console.error("[Alarm] widget snapshot pass failed:", (err as Error).message);
  }

  // Written only when the pass did something.
  //
  // This runs every five minutes, 288 times a day, and the overwhelming
  // majority of ticks evaluate nothing, because each alarm carries its own
  // interval. Recording those would add a hundred thousand rows a year saying
  // "nothing was due", and an audit trail nobody can read is not one.
  //
  // The console line above keeps the full per-tick detail in CloudWatch, where
  // volume is free and nobody is trying to read a history.
  const didSomething = summary.fired > 0 || summary.recovered > 0
    || summary.publishFailures > 0 || summary.unreadable > 0;
  if (didSomething) {
    await logSync("alarms", SCHEDULE_ACTOR, {
      details: `${summary.evaluated} alarms evaluated: ${summary.fired} fired, `
        + `${summary.recovered} recovered`
        + (summary.unreadable ? `, ${summary.unreadable} unreadable` : "")
        + (summary.publishFailures ? `, ${summary.publishFailures} could not be sent` : ""),
      // Unreadable is not a failure of the pass: a widget whose data could not
      // be read is reported and deliberately not resolved, which is the safe
      // reading. Only a send that did not arrive is a failure of this run.
      failed: summary.publishFailures > 0,
      startedAt,
    });
  }

  // Deliberately not thrown. A publish failure is already logged and counted,
  // and failing the invocation would only make EventBridge retry the whole
  // pass, re-reading every widget and re-sending whatever did succeed.

  // ── the grouped feeds ──
  //
  // Buffered by the webhook, drained here, because this is already a tick that
  // runs every few minutes and a second schedule would be a second thing to
  // keep in step with the first. The cost is latency: an event waits up to one
  // tick, which is the trade grouping was asked for.
  //
  // Its own try, so a failure to flush cannot lose the alarm summary above.
  try {
    const flushed = await flushPending({
      listPending,
      markSent: markPendingSent,
      // The security channel has no feed settings row. It reads the security
      // tab's own toggle instead, and is always grouped: an alert reaches the
      // buffer only after that tab decided it should be sent at all.
      settings: async (feed: string) => {
        if (feed !== "security") return getFeedSettings(feed as any);
        const sec = await getSecuritySettings();
        return {
          enabled: sec.enabled,
          groupId: sec.groupId,
          grouping: "per-repository",
          subjectTemplate: sec.subjectTemplate,
          bodyTemplate: sec.bodyTemplate,
        };
      },
      topicArnFor: async (groupId: string) => (await getGroup(groupId))?.topicArn,
      publish,
      timezone: async () => (await getSecuritySettings()).timezone,
      org,
    });
    if (flushed.messages > 0 || flushed.failures > 0) {
      console.log(
        `[Notify] Flushed ${flushed.items} buffered events as ${flushed.messages} ` +
        `message(s) across ${flushed.repos} repositor${flushed.repos === 1 ? "y" : "ies"}` +
        (flushed.failures ? `, ${flushed.failures} publish failure(s) left pending` : ""),
      );
    }
  } catch (err) {
    console.error("[Notify] Flushing buffered notifications failed:", (err as Error).message);
  }

  // ── stale pull requests ──
  //
  // On the same tick, and gated by its own seven-day interval rather than the
  // tick's. Running here rather than on a schedule of its own keeps one clock
  // in the system; the pass itself decides what is actually due.
  //
  // Its own try, so a GitHub outage cannot take the alarm summary with it.
  try {
    // Checked before anything is fetched. A feature switched off must cost
    // nothing on the tick, not fetch the world and then decline to act on it.
    //
    // Only monitoring is checked here. Reminders being off stops the posting,
    // not the walk, the branch below still stores the snapshot the tab opens
    // on. Gating the fetch on reminders as well was the same line for a while,
    // and it made the common configuration, monitoring on, reminders off,
    // the one where nothing kept the stored list warm, so every first open of
    // the day paid for a live walk.
    const prSettings = await getPrSettings();
    if (!prSettings.monitoringEnabled) {
      throw { __skip: true };
    }

    const { fetchOpenPrs } = await import("../services/prNudgeService");
    const graphql = (query: string, variables: Record<string, unknown>) =>
      (octokit as any).graphql(query, variables);

    // Stored whatever happens next: the walk has already been paid for, and
    // the tab opening on it is what stops every launch waiting.
    const storeSnapshot = async (r: { prs: any[]; truncated: boolean }) => {
      const { savePrSnapshot } = await import("../services/alarmService");
      await savePrSnapshot(r).catch(err =>
        console.warn("[PR] could not store the snapshot:", err?.message ?? err));
      return r;
    };

    if (!prSettings.remindersEnabled) {
      // Monitoring without reminders: walk, store, message nobody.
      await storeSnapshot(await fetchOpenPrs(graphql, org));
      throw { __skip: true };
    }

    // Read once for the pass, not per pull request: the same set applies to
    // every one of them. Below the branch above, so the configuration that
    // never reminds anybody does not read the mute list 288 times a day.
    const mutes = await getPrMutes();

    const summary = await runNudgePass({
      mutes: { global: mutes.global, byRepo: mutes.byRepo },
      listPrs: () => fetchOpenPrs(graphql, org).then(storeSnapshot),
      getState: (repo, number) => getPrState(repo, number),
      recordNudge,
      // The scheduled pass is the one that matters here: it is what keeps
      // running for the months a pause has to survive.
      touchState: touchPrState,
      listComments: async (repo, number) => {
        const [owner, name] = repo.split("/");
        const { data } = await (octokit as any).rest.issues.listComments({
          owner, repo: name, issue_number: number, per_page: 100,
        });
        // Ours means posted by this App's bot account. Comparing on type rather
        // than on a name, so renaming the App does not orphan every reminder it
        // has already posted and start a second pile.
        return data.map((c: any) => ({
          id: c.id, body: c.body ?? "", authorIsApp: c.user?.type === "Bot",
        }));
      },
      deleteComment: async (repo, id) => {
        const [owner, name] = repo.split("/");
        await (octokit as any).rest.issues.deleteComment({ owner, repo: name, comment_id: id });
      },
      postComment: async (repo, number, body) => {
        const [owner, name] = repo.split("/");
        const { data } = await (octokit as any).rest.issues.createComment({
          owner, repo: name, issue_number: number, body,
        });
        return data?.id;
      },
    });

    if (summary.due > 0) {
      console.log(
        `[PR] ${summary.considered} open, ${summary.due} due, ${summary.posted} reminded, ` +
        `${summary.skippedPaused} paused, ${summary.failed} failed`,
      );
    }

    // Same rule as the alarms above: a pass that reminded nobody is not history.
    // A reminder is a message sent to a real person, so the ones that happened
    // are worth a row naming how many and when.
    if (summary.posted > 0 || summary.failed > 0) {
      await logSync("reminders", SCHEDULE_ACTOR, {
        details: `${summary.considered} open pull requests, ${summary.due} due, `
          + `${summary.posted} reminded`
          + (summary.skippedPaused ? `, ${summary.skippedPaused} paused` : "")
          + (summary.failed ? `, ${summary.failed} failed` : ""),
        failed: summary.failed > 0 && summary.posted === 0,
        startedAt,
      });
    }
  } catch (err) {
    // The switch is not a failure, so it is not logged as one.
    if (!(err as any)?.__skip) {
      console.error("[PR] Stale pull request pass failed:", (err as Error).message);
    }
  }

}
