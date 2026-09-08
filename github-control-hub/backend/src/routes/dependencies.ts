import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited, withSecondaryRetry } from "../utils/rateLimit";
import { sendIfPermissionDenied } from "../utils/permissionError";
import { fetchAllCursorPages } from "../utils/cursorPages";
import { fetchRenovatePrs } from "../services/renovateService";
import { getOrgConfig, updateRenovateBot } from "../services/orgConfigService";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { mapAlert, fetchOrgDependencyAlerts, fetchRepoAlertStatus , fetchRepoFixStatus} from "../services/dependencyService";
import { isValidRepoName } from "../utils/validation";
import {
  saveDependencySnapshot, readDependencySnapshot, isFresh, isDueForRefresh,
  refreshIfDue, refreshNow, isRefreshing,
} from "../services/dependencySnapshot";
import { mockCleanAlert, mockDisabledAlert } from "../services/dependencyMarkers";
import { buildDependencyView } from "../services/dependencyView";
import { summariseAlerts } from "../services/dependencySummary";
import { fetchDependabotPrs, packageFromBranch } from "../services/dependabotPrs";

const router = Router();

/**
 * Recompute in the background and store the result.
 *
 * Never throws into its caller: it is started without being awaited, and an
 * unhandled rejection from a refresh nobody is waiting for should not be able
 * to take the process down.
 */
async function refreshDependencySnapshot(octokit: any, org: string): Promise<void> {
  try {
    const { rows, degraded } = await buildDependencyView(octokit, org);
    // A sweep GitHub refused comes back empty, which becomes a view of nothing
    // but "clean" markers. Stored, that reports an organization with no
    // findings, and it would stand until the next sweep succeeded.
    if (degraded) {
      console.warn("[Dependencies] Background refresh swept partially; not stored.");
      return;
    }
    await saveDependencySnapshot(rows);
  } catch (err: any) {
    console.warn(`[Dependencies] Background refresh failed: ${err?.message ?? err}`);
  }
}

/** The severity filter, applied to whichever rows were produced. */
function applyFilters(alerts: any[], severity?: string): any[] {
  return severity ? alerts.filter(a => a.severity === severity) : alerts;
}

/**
 * When the stored view was last computed.
 *
 * A separate request rather than a field on the rows, because the rows are an
 * array and every caller already treats them as one. A timestamp is not worth
 * reshaping that contract and touching every consumer for.
 *
 * Null means nothing is stored, which is what a first open looks like and is
 * different from an old answer.
 */
/**
 * Why each repository has the fix pull requests it has, or has none.
 *
 * Its own endpoint, and live rather than stored, for two reasons. The stored
 * sweep is shared with the alarm pass, and a search added there would be spent
 * every half hour on a question no alarm asks. And this answer goes stale in a
 * way the sweep does not: somebody presses a button, a pull request appears,
 * and the count is wrong within the minute.
 */
router.get("/dependencies/fix-prs", async (_req: Request, res: Response) => {
  try {
    const token = getSystemToken() || _req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const octokit = createOctokit(token, "Dependabot pull request count");
    const org = getOrg();

    /**
     * Stored first. This was the last live GitHub call the Vulnerabilities tab
     * made on every open: a search against the thirty-a-minute budget, then a
     * GraphQL batch per fifty pull requests. Everything else on that tab reads
     * from storage, so this was what remained of the wait.
     */
    const {
      readView, saveView, isViewDue, refreshViewIfDue,
    } = await import("../services/viewSnapshot");

    const storedPrs = await readView<any>("dependabot-prs");
    if (storedPrs) {
      res.json({ counts: storedPrs.data.counts, prs: storedPrs.data.prs, computedAt: storedPrs.computedAt });
      if (isViewDue("dependabot-prs", storedPrs)) {
        void refreshViewIfDue("dependabot-prs", async () => {
          const fresh = await fetchDependabotPrs(
            async (q, page) => {
              const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
                q, per_page: 100, page, advanced_search: "true",
              });
              return { items: r.data?.items ?? [] };
            }, org);
          if (fresh) await saveView("dependabot-prs", fresh);
        });
      }
      return;
    }

    const found = await fetchDependabotPrs(
      async (q, page) => {
        const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
          q, per_page: 100, page, advanced_search: "true",
        });
        return { items: r.data?.items ?? [] };
      },
      org,
    );

    // Null stays null across the wire. A client shown {} would render every
    // repository as having no open pull requests, which is a finding, and
    // nobody established it.
    if (!found) return res.json({ counts: null, prs: null });

    /**
     * The check state, from the module the Renovate view uses.
     *
     * The same question of the same objects, so the same code answers it: two
     * copies would be two places for "unknown" to quietly become "passing".
     * One GraphQL batch per fifty, on a budget the search does not touch.
     */
    if (found.prs.length > 0) {
      const { fetchPullRequestDetails, mergeReadiness } = await import("../services/pullRequestDetails");
      const details = await fetchPullRequestDetails(
        (query, vars) => (octokit as any).graphql(query, vars),
        org,
        found.prs.map(p => ({ repo: p.repo, number: p.number })),
      );
      for (const pr of found.prs) {
        const detail = details.get(`${pr.repo}#${pr.number}`);
        Object.assign(pr, detail ?? {}, {
          readiness: mergeReadiness(detail),
          packageName: packageFromBranch(detail?.headRefName),
        });
      }
    }

    // Stored on the way out, so the next open is served rather than searched.
    await saveView("dependabot-prs", found);
    res.json({ counts: found.counts, prs: found.prs });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/dependencies/age", async (_req: Request, res: Response) => {
  try {
    // The two scalars this needs, without pulling the payload over the wire
    // or decompressing it. This endpoint polls every minute.
    const { snapshotHealth, readSnapshotAge } = await import("../services/dependencySnapshot");
    const age = await readSnapshotAge();
    res.json({
      computedAt: age.computedAt,
      fresh: isFresh(age),
      // Whether a sweep is actually running, rather than inferred from the
      // age. Stale and refreshing are different states, and the tab said the
      // second whenever the first was true.
      refreshing: isRefreshing(),
      // So the tab can say why it is slow, rather than just being slow.
      ...snapshotHealth(),
    });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token, "Vulnerabilities tab");
    const org = getOrg();

    /**
     * The whole-organization view, served from store when there is one.
     *
     * Only the unfiltered view is stored. A repository filter is one cheap
     * request and a severity filter is a filter over the same rows, so neither
     * is worth a row of its own, and both are applied to whatever comes back.
     */
    const wholeOrg = !req.query.repo;

    const repoFilter = req.query.repo as string | undefined;
    const severityFilter = req.query.severity as string | undefined;

    // The one query parameter that becomes a path segment. Every other route
    // taking a repository name validates it; this one did not.
    if (repoFilter !== undefined && !isValidRepoName(repoFilter)) {
      return res.status(400).json({ error: "Invalid repository name" });
    }

    let allAlerts: any[] = [];
    // Whether the sweep behind those rows read the whole organization. A
    // partial one must not be stored as the answer.
    let sweptPartially = false;

    /**
     * The stored answer, when there is one and it is recent.
     *
     * Served without waiting, and a fresh sweep started behind the reader so
     * the next open is current. The alternative is what this replaced: a tab
     * that takes as long as an org-wide sweep every time the app is launched,
     * because the in-memory cache belongs to a process that has just started.
     */
    if (wholeOrg) {
      /**
       * Timed, and said out loud, because "the tab is slow" has three
       * completely different causes and they are indistinguishable from the
       * outside: nothing stored so it swept live, storage itself being slow to
       * answer, or a fast answer that is simply large. Each line below names
       * which one happened.
       */
      const startedAt = Date.now();
      const stored = await readDependencySnapshot();
      if (stored) {
        const rows = applyFilters(stored.alerts, severityFilter);
        console.log(
          `[Dependencies] Served ${rows.length} rows from storage in `
          + `${Date.now() - startedAt}ms, swept ${stored.computedAt}`);
        res.json(rows);
        // Due, not merely stale. Freshness is ten minutes and drives what the
        // tab *says*; this is half an hour and drives what it *does*. Using the
        // first for the second is what made every launch sweep.
        if (isDueForRefresh(stored)) {
          // Deliberately not awaited. The reader already has an answer, and
          // making them wait for the next one is the delay this exists to
          // remove. Failures are logged inside.
          // Throttled and deduplicated. Serving the stored copy was always
          // right; recomputing because somebody looked was not.
          void refreshIfDue(() => refreshDependencySnapshot(octokit, org));
        }
        return;
      }
    }

    if (wholeOrg) {
      // The expensive path, and the one somebody waits through. Saying so
      // here is the difference between "the tab is slow" and "the tab had
      // nothing stored, so it walked the organization while you waited".
      console.log("[Dependencies] Nothing stored for this organization, sweeping live while the tab waits");
    }

    if (repoFilter) {
      const data = await fetchAllCursorPages((after) =>
        octokit.rest.dependabot.listAlertsForRepo({
          owner: org,
          repo: repoFilter,
          state: "open",
          per_page: 100,
          ...(after ? { after } : {}),
        })
      );
      allAlerts = data.map((a: any) => mapAlert(a, repoFilter, org));
      
      // No alerts means one of two things, and the caller has to be able to
      // tell them apart: alerts are switched off, or they are on and the repo
      // is clean. Returning an empty list for both made a clean repo look like
      // one that had vanished, so each case gets its marker, the same
      // contract the org-wide branch below returns.
      if (allAlerts.length === 0) {
        try {
          await octokit.rest.repos.checkVulnerabilityAlerts({ owner: org, repo: repoFilter });
          allAlerts.push(mockCleanAlert(repoFilter, org));
        } catch (err: any) {
          if (err.status === 404) {
            allAlerts.push(mockDisabledAlert(repoFilter, org));
          }
        }
      }
    } else {
      const built = await buildDependencyView(octokit, org);
      allAlerts = built.rows;
      sweptPartially = built.degraded;
    }

    // Stored before filtering, so the row backs every view rather than the one
    // that happened to be asked for first, and never when the sweep behind it
    // was partial: those rows understate the organization in the reassuring
    // direction, and stored they would stand as the answer for hours.
    if (wholeOrg && !sweptPartially) await saveDependencySnapshot(allAlerts);

    res.json(applyFilters(allAlerts, severityFilter));
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/enable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo, act as the user so GitHub authorizes it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token, "Turning Dependabot on or off");
    const org = getOrg();

    try {
      await octokit.rest.repos.enableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "enable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.enable", req.user?.login || "system", repo, "Dependabot",
      `Enabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "disable_dependabot", params: { repo } } }
    );

    // Same reason as the bulk action: the stored answer no longer describes
    // this repository, and recomputing behind the response keeps the next open
    // fast as well as correct.
    //
    // Through the guard, not around it. Called directly, as it was, two toggles
    // in a row start two concurrent organization-wide walks and neither appears
    // in the tab's "refreshing" line.
    const { invalidateDependencySweep } = await import("../services/dependencyService");
    invalidateDependencySweep();
    void refreshNow(() => refreshDependencySnapshot(octokit, org));

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/disable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo, act as the user so GitHub authorizes it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token, "Turning Dependabot on or off");
    const org = getOrg();

    try {
      await octokit.rest.repos.disableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "disable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.disable", req.user?.login || "system", repo, "Dependabot",
      `Disabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "enable_dependabot", params: { repo } } }
    );

    // Same reason as the bulk action: the stored answer no longer describes
    // this repository, and recomputing behind the response keeps the next open
    // fast as well as correct.
    //
    // Through the guard, not around it. Called directly, as it was, two toggles
    // in a row start two concurrent organization-wide walks and neither appears
    // in the tab's "refreshing" line.
    const { invalidateDependencySweep } = await import("../services/dependencyService");
    invalidateDependencySweep();
    void refreshNow(() => refreshDependencySnapshot(octokit, org));

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

/**
 * Turn Dependabot on or off across many repositories in one request.
 *
 * One request rather than one per repository, because the client cannot pace
 * itself usefully: the browser does not know what GitHub told the last call,
 * and clicking down a list is exactly the burst that trips the secondary rate
 * limit. Doing it here means the pacing sits next to the errors that cause it.
 *
 * The caller's own token, like every other write in this file. GitHub decides
 * per repository whether they may, so a bulk action can never reach further
 * than the person could one at a time.
 */
/**
 * Write the grouped security-updates configuration into repositories.
 *
 * Uses the caller's own token rather than the app's, deliberately. This opens
 * pull requests and commits files, and those should carry the name of the
 * person who asked for them, not a shared identity nobody can ask about later.
 * It also means GitHub applies that person's permissions: a repository they
 * cannot write to refuses, which is the correct answer.
 */
router.post("/dependencies/config", async (req: Request, res: Response) => {
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  const { repos, mode } = req.body ?? {};
  const list = Array.isArray(repos)
    ? repos.filter((r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 200)
    : [];
  if (mode !== "pr" && mode !== "commit") {
    return res.status(400).json({ error: "mode must be pr or commit" });
  }
  if (list.length === 0) return res.status(400).json({ error: "Pick at least one repository" });
  // Lower than the settings bulk allows. Each repository here is four or five
  // writes rather than one, and the whole run has to finish inside the request.
  if (list.length > 50) {
    return res.status(400).json({ error: "Up to 50 repositories at a time" });
  }

  try {
    const { runDependabotRollout } = await import("../services/dependabotRollout");
    const octokit = createOctokit(token, "Rolling out Dependabot configuration");

    /**
     * Each repository's configuration is built from its own alerts, so the
     * stored sweep is the input. An entry invented from a guess about the
     * repository's shape fails silently: Dependabot finds no manifest there and
     * opens nothing, which looks exactly like the bug this is fixing.
     */
    const stored = await readDependencySnapshot();
    const alerts = stored?.alerts ?? (await buildDependencyView(octokit, getOrg())).rows;
    const byRepo = new Map<string, any[]>();
    for (const a of alerts as any[]) {
      if (a.clean || a.disabled || a.scanning) continue;
      const rows = byRepo.get(a.repo);
      if (rows) rows.push(a);
      else byRepo.set(a.repo, [a]);
    }

    /**
     * Which of these have security updates switched off.
     *
     * Read from the same stored rows, and only where the answer is known:
     * `fixesEnabled` is undefined for a repository the caller cannot
     * administer, and warning about one of those would be a claim nobody made.
     */
    const fixesOff = new Set<string>();
    for (const [repo, rows] of byRepo) {
      if (rows.some(r => r.fixesEnabled === false)) fixesOff.add(repo);
    }

    const summary = await runDependabotRollout(octokit, getOrg(), list, byRepo, mode, { fixesOff });

    for (const r of summary.results.filter(x => x.outcome === "opened" || x.outcome === "committed")) {
      await logActivity("dependabot.enable" as any, req.user!.login, r.repo, "Dependabot",
        r.outcome === "opened"
          ? `Opened a pull request enabling grouped Dependabot security updates on ${r.repo}`
          : `Enabled grouped Dependabot security updates on ${r.repo}`);
    }

    res.json(summary);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

/**
 * Close every open Dependabot pull request on the chosen repositories.
 *
 * The caller's own token, never the app's. This is a destructive write to
 * somebody's repositories, and it should carry the name of the person who
 * asked for it and be authorised as them: a repository they cannot write to
 * must refuse, which is the correct answer.
 */
router.post("/dependencies/close-prs", async (req: Request, res: Response) => {
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  const { repos } = req.body ?? {};
  const list = Array.isArray(repos)
    ? repos.filter((r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 200)
    : [];

  // An empty list is refused rather than treated as "everything". The service
  // refuses it too; this is the same guard at the edge, because the cost of
  // getting it wrong is closing every Dependabot pull request in the
  // organization and suppressing every one of those fixes.
  if (list.length === 0) return res.status(400).json({ error: "Pick at least one repository" });
  if (list.length > 100) {
    return res.status(400).json({ error: "Up to 100 repositories at a time" });
  }

  try {
    const { closeDependabotPrs } = await import("../services/dependabotClose");
    const octokit = createOctokit(token, "Closing Dependabot pull requests");

    const summary = await closeDependabotPrs(octokit, getOrg(), list, async (q) => {
      const found: { repo: string; number: number }[] = [];
      for (let page = 1; page <= 10; page++) {
        const r: any = await withSecondaryRetry(() =>
          (octokit as any).rest.search.issuesAndPullRequests({
            q, per_page: 100, page, advanced_search: "true",
          }));
        const items = r.data?.items ?? [];
        for (const item of items) {
          const repo = String(item?.repository_url ?? "").split("/").pop();
          if (repo && Number.isInteger(item?.number)) found.push({ repo, number: item.number });
        }
        if (items.length < 100) break;
      }
      return found;
    });

    // One row per repository that lost pull requests, not one for the run: the
    // feed is where somebody looks to find out what happened to a repository,
    // and "closed 47 pull requests" answers that for none of them.
    for (const [repo, count] of Object.entries(summary.byRepo)) {
      await logActivity("dependabot.disable" as any, req.user!.login, repo, "Dependabot",
        `Closed ${count} Dependabot pull request${count === 1 ? "" : "s"} on ${repo}`);
    }

    res.json(summary);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/bulk", async (req: Request, res: Response) => {
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  const { repos, action } = req.body ?? {};
  const list = Array.isArray(repos)
    ? repos.filter((r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 200)
    : [];
  const actions = ["alerts-on", "alerts-off", "fixes-on", "fixes-off", "retrigger"];
  if (!actions.includes(action)) {
    return res.status(400).json({ error: `action must be one of ${actions.join(", ")}` });
  }
  if (list.length === 0) return res.status(400).json({ error: "Pick at least one repository" });
  // A ceiling, because the whole run happens inside one request and a list of
  // a thousand would outlive the connection waiting for it.
  if (list.length > 200) {
    return res.status(400).json({ error: "Up to 200 repositories at a time" });
  }

  try {
    const { runDependabotBulk } = await import("../services/dependabotBulk");
    const octokit = createOctokit(token, "Turning Dependabot on or off");
    const summary = await runDependabotBulk(octokit, getOrg(), list, action);

    // One row per repository that changed, not one for the batch: the feed is
    // where somebody looks to find out what happened to a given repository, and
    // a single "changed 40 repositories" row answers that for none of them.
    const verb = action === "alerts-off" ? "dependabot.disable" : "dependabot.enable";
    for (const r of summary.results.filter(x => x.ok)) {
      await logActivity(verb as any, req.user!.login, r.repo, "Dependabot",
        action === "alerts-on" ? `Enabled Dependabot alerts on ${r.repo}`
          : action === "alerts-off" ? `Disabled Dependabot alerts on ${r.repo}`
          : action === "retrigger" ? `Re-triggered Dependabot security updates on ${r.repo}`
          : action === "fixes-on" ? `Enabled Dependabot security updates on ${r.repo}`
          : `Disabled Dependabot security updates on ${r.repo}`,
        undefined, "app");
    }

    // Invalidated so the tab reflects the change rather than the minute-old
    // sweep it was drawn from.
    const { invalidateDependencySweep } = await import("../services/dependencyService");
    invalidateDependencySweep();
    // The stored answer describes the account as it was a moment ago, and the
    // point of pressing this was to change it. Recomputed behind the response
    // rather than deleted: deleting would make the next open slow again, which
    // is the thing the store exists to prevent.
    void refreshNow(() => refreshDependencySnapshot(octokit, getOrg()));

    res.json(summary);
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "dependabot bulk") });
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token, "Vulnerabilities tab");
    const org = getOrg();

    /**
     * From storage first, because these counts are arithmetic over exactly the
     * rows already stored and nothing needs fetching to produce them.
     *
     * This endpoint used to sweep the organization live on every call, which
     * on 7,047 alerts is seventy-one sequential pages. The tab's spinner waits
     * on the list *and* these counts, so serving the list instantly from
     * storage bought nothing: every first open after an app launch still
     * waited for the whole walk. Later opens in the same session were fast
     * only because the sweep is held briefly in memory, which is what made it
     * look like a cold-start mystery rather than a missing read.
     */
    const stored = await readDependencySnapshot();
    if (stored) {
      // A partial sweep understates the organization in the reassuring
      // direction, so it is refused here exactly as a degraded live sweep is.
      if (stored.degraded) {
        return res.json({ critical: 0, high: 0, medium: 0, low: 0, repos_with_vulns: 0 });
      }
      return res.json(summariseAlerts(stored.alerts));
    }

    // Nothing stored: the first open for this organization. Shares the sweep
    // with the tab above and with the alarm evaluator, which also brings the
    // 400 tolerance here. This endpoint caught 403 and 404 but not 400, the
    // same rejected-pagination failure that blanked the Dependabot tab would
    // have turned this summary into a 500.
    const sweep = await fetchOrgDependencyAlerts(octokit, org);
    if (sweep.degraded) {
      return res.json({ critical: 0, high: 0, medium: 0, low: 0, repos_with_vulns: 0 });
    }

    res.json(summariseAlerts(sweep.alerts));
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

// mapAlert lives in services/dependencyService.ts, shared with the alarm
// evaluator so the number on the screen and the number in the email come from
// the same code.



/**
 * Renovate pull requests.
 *
 * Read-only by design. The app lists what the bot has raised and links out to
 * GitHub; merging happens there, with GitHub authorizing the person doing it.
 * There is deliberately no route here that could merge, and repro-renovate.ts
 * asserts that no code anywhere in the backend can.
 */
router.get("/renovate", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const bot = (await getOrgConfig()).renovateBot;
    // Not an error: most organizations do not run Renovate. The UI says so
    // rather than showing an empty table, which reads as a broken fetch.
    if (!bot) return res.json({ configured: false, prs: [], truncated: false, bot: null });

    const octokit = createOctokit(token, "Renovate pull request search");
    const {
      readView, saveView, isViewDue,
      refreshViewIfDue, isViewRefreshing,
    } = await import("../services/viewSnapshot");

    /**
     * Stored first, for the same reason the dashboards are: the search behind
     * this draws on the thirty-a-minute budget, and the details behind it a
     * GraphQL batch per fifty pull requests.
     *
     * Read whichever form was asked for, which is the part that was wrong. Only
     * the detailed form is *stored*, and the read was gated on the same flag,
     * so the call the page makes on every open, the one that only wants a
     * number for the tab, could never be served from the row and ran a live
     * organization-wide search every single time. It was the last live GitHub
     * call on opening this page, and it was there to put a count on a label.
     *
     * The stored row is a superset of what the count needs, so serving it
     * answers both. Still only stored below when the details were asked for:
     * keeping a second, thinner row in step with this one would buy nothing.
     */
    const stored = await readView<any>("renovate-prs");
    if (stored) {
      res.json({
        configured: true, ...stored.data,
        computedAt: stored.computedAt,
        refreshing: isViewRefreshing("renovate-prs"),
      });
      if (isViewDue("renovate-prs", stored)) {
        void refreshViewIfDue("renovate-prs", async () => {
          await saveView("renovate-prs",
            await buildRenovatePrs(octokit, getOrg(), bot));
        });
      }
      return;
    }

    const result = await fetchRenovatePrs(
      // Search is the smallest allowance GitHub gives and the likeliest thing
      // here to meet a secondary limit, which is a request to wait rather than
      // a refusal. Without this the widget showed the raw refusal, and a wait
      // of a few seconds would have answered it.
      async (q, page) => withSecondaryRetry(async () => {
        const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
          q, per_page: 100, page, advanced_search: "true",
        });
        return { items: r.data?.items ?? [] };
      }),
      getOrg(), bot,
    );
    /**
     * The details, for the open ones only.
     *
     * Closed pull requests cannot be merged and nobody is deciding anything
     * about them, so paying a GraphQL batch for their check status would buy
     * nothing. On an organization that keeps months of closed ones that is
     * most of the list.
     */
    /**
     * Only when somebody is looking at the Renovate view.
     *
     * The Vulnerabilities page reads this endpoint on every open, whichever
     * view is showing, purely to put a count on the tab. Enriching every open
     * pull request to do that spent a GraphQL batch on a screen nobody had
     * open, on the slowest tab in the app.
     *
     * The search behind it is held for a minute, so the second call, the one
     * that does want details, reuses it rather than searching twice.
     */
    const open = req.query.details === "1"
      ? result.prs.filter(p => p.state === "open")
      : [];
    if (open.length > 0) {
      const { fetchPullRequestDetails, mergeReadiness } = await import("../services/pullRequestDetails");
      const details = await fetchPullRequestDetails(
        (query, vars) => (octokit as any).graphql(query, vars),
        getOrg(),
        open.map(p => ({ repo: p.repo, number: p.number })),
      );
      for (const pr of open) {
        const detail = details.get(`${pr.repo}#${pr.number}`);
        Object.assign(pr, detail ?? {}, { readiness: mergeReadiness(detail) });
      }
    }

    // Stored on the way out, so the next open is served rather than computed.
    if (req.query.details === "1") {
      await saveView("renovate-prs", result);
    }
    res.json({ configured: true, ...result });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

/**
 * What one Renovate pull request patches.
 *
 * Fetched per pull request, when somebody expands it, rather than for all of
 * them up front: the body of a grouped update is large, and most rows are never
 * opened. So the cost is proportional to what is actually looked at.
 */
router.get("/renovate/:repo/:number/changes", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const repo = String(req.params.repo);
    const number = Number(req.params.number);
    // Both become part of a GraphQL document, so both are checked rather than
    // interpolated on trust.
    if (!isValidRepoName(repo)) return res.status(400).json({ error: "Invalid repository name" });
    if (!Number.isInteger(number) || number <= 0) {
      return res.status(400).json({ error: "Invalid pull request number" });
    }

    const octokit = createOctokit(token, "Renovate pull request search");
    const data: any = await (octokit as any).graphql(
      `query($org:String!, $repo:String!, $number:Int!) {
        repository(owner: $org, name: $repo) {
          pullRequest(number: $number) {
            bodyText
            files(first: 20) { nodes { path } }
          }
        }
      }`,
      { org: getOrg(), repo, number },
    );

    const pr = data?.repository?.pullRequest;
    const { parseRenovateChanges } = await import("../services/renovateChanges");

    res.json({
      // Null means the body could not be read as a package table, which is
      // different from a pull request that changes nothing. The UI says so.
      changes: parseRenovateChanges(pr?.bodyText),
      files: (pr?.files?.nodes ?? []).map((f: any) => f?.path).filter(Boolean),
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

/**
 * The Renovate pull requests with their details, computed fresh.
 *
 * Shared by the view when nothing is stored and by the hourly pass that stores
 * it, so the stored answer and the live one cannot differ in what they carry.
 */
export async function buildRenovatePrs(octokit: any, org: string, bot: string) {
  const result = await fetchRenovatePrs(
    async (q, page) => withSecondaryRetry(async () => {
      const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
        q, per_page: 100, page, advanced_search: "true",
      });
      return { items: r.data?.items ?? [] };
    }),
    org, bot,
  );

  const open = result.prs.filter(p => p.state === "open");
  if (open.length > 0) {
    const { fetchPullRequestDetails, mergeReadiness } = await import("../services/pullRequestDetails");
    const details = await fetchPullRequestDetails(
      (query, vars) => (octokit as any).graphql(query, vars),
      org, open.map(p => ({ repo: p.repo, number: p.number })));
    for (const pr of open) {
      const detail = details.get(`${pr.repo}#${pr.number}`);
      Object.assign(pr, detail ?? {}, { readiness: mergeReadiness(detail) });
    }
  }
  return result;
}

/**
 * The Renovate dashboards, computed fresh.
 *
 * A function rather than inline in the route, because two things build this
 * now: the view when nothing is stored, and the hourly pass that stores it.
 * Two copies would be two places for the bot-name resolution to drift.
 */
export async function buildRenovateDashboards(octokit: any, org: string, bot: string) {
  const { fetchRenovateDashboards } = await import("../services/renovateDashboards");
  return fetchRenovateDashboards(
    async (q, page) => withSecondaryRetry(async () => {
      const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
        q, per_page: 100, page, advanced_search: "true",
      });
      return { items: r.data?.items ?? [] };
    }),
    org, bot,
  );
}

/**
 * Every repository's Renovate Dependency Dashboard.
 *
 * Self-hosted Renovate has no API and no service to connect to, so this is the
 * only channel: an issue per repository that the bot writes and reads back.
 */
router.get("/renovate/dashboards", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const bot = (await getOrgConfig()).renovateBot;
    if (!bot) return res.json({ configured: false, dashboards: [], unparsed: 0, bot: null });

    const octokit = createOctokit(token, "Renovate dependency dashboards");
    const {
      readView, saveView, isViewDue,
      refreshViewIfDue, isViewRefreshing, viewHealth,
    } = await import("../services/viewSnapshot");

    /**
     * Stored first, and served without waiting.
     *
     * Both halves of this view cost a search against the thirty-a-minute
     * budget, and the dashboard half then parses a body per repository. Doing
     * that while somebody waits is what made the tab slow; doing it on every
     * open is what kept spending the budget.
     */
    const stored = await readView<any>("renovate-dashboards");
    if (stored) {
      res.json({
        configured: true, bot, ...stored.data,
        computedAt: stored.computedAt,
        refreshing: isViewRefreshing("renovate-dashboards"),
        ...viewHealth("renovate-dashboards"),
      });
      if (isViewDue("renovate-dashboards", stored)) {
        void refreshViewIfDue("renovate-dashboards", async () => {
          await saveView("renovate-dashboards",
            await buildRenovateDashboards(octokit, getOrg(), bot));
        });
      }
      return;
    }

    // Nothing stored: the first open for this organization.
    const sweep = await buildRenovateDashboards(octokit, getOrg(), bot);
    await saveView("renovate-dashboards", sweep);
    res.json({
      configured: true, bot, ...sweep,
      computedAt: new Date().toISOString(),
      refreshing: false,
      ...viewHealth("renovate-dashboards"),
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

/** The dependency inventory for one repository, read when somebody opens it. */
router.get("/renovate/dashboards/:repo/:number/dependencies", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const repo = String(req.params.repo);
    const number = Number(req.params.number);
    if (!isValidRepoName(repo)) return res.status(400).json({ error: "Invalid repository name" });
    if (!Number.isInteger(number) || number <= 0) {
      return res.status(400).json({ error: "Invalid issue number" });
    }

    const octokit = createOctokit(token, "Renovate dependency dashboards");
    const { fetchDetectedDependencies } = await import("../services/renovateDashboards");
    res.json({ detected: await fetchDetectedDependencies(octokit, getOrg(), repo, number) });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

/**
 * Tick one checkbox on one dashboard.
 *
 * The caller's own token, never the app's: this edits an issue in somebody's
 * repository and instructs a bot to act, so it should carry the name of the
 * person who asked and be authorised as them.
 */
router.post("/renovate/dashboards/:repo/:number/tick", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken;
    if (!token) return res.status(401).json({ error: "No GitHub token provided" });

    const repo = String(req.params.repo);
    const number = Number(req.params.number);
    const marker = String((req.body ?? {}).marker ?? "");

    if (!isValidRepoName(repo)) return res.status(400).json({ error: "Invalid repository name" });
    if (!Number.isInteger(number) || number <= 0) {
      return res.status(400).json({ error: "Invalid issue number" });
    }
    // The marker is matched literally against the issue body, so its shape is
    // checked rather than trusted. Renovate's own markers are a name, a dash,
    // and a branch.
    if (!marker || marker.length > 300 || !/^[\w-]+(=[\w./+-]+)?$|^manual job$/.test(marker)) {
      return res.status(400).json({ error: "Invalid checkbox" });
    }

    const octokit = createOctokit(token, "Renovate dependency dashboards");
    const { tickDashboard } = await import("../services/renovateDashboards");
    const result = await tickDashboard(octokit, getOrg(), repo, number, marker);

    if (result.ticked) {
      await logActivity("renovate.request" as any, req.user!.login, repo, "Renovate",
        `Asked Renovate to act on ${marker} in ${repo}`);
    }
    res.json(result);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

/** Naming the bot account is org-wide configuration, so it is admin-gated. */
router.put("/renovate/bot", async (req: Request, res: Response) => {
  try {
    if (!(await isControlHubAdmin(req.user!.login, req.user!.accessToken))) {
      return res.status(403).json({
        code: "CONTROL_HUB_ADMIN_REQUIRED",
        error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ` +
          `change which account Renovate raises PRs as.`,
      });
    }
    const bot = String(req.body?.bot ?? "").trim();
    // A GitHub login: letters, digits, hyphens, and the [bot] suffix some
    // apps carry. Rejected here so it cannot become a malformed search query.
    if (bot && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/.test(bot)) {
      return res.status(400).json({ error: `"${bot}" is not a valid GitHub username` });
    }
    const updated = await updateRenovateBot(bot);
    await logActivity("config.updated", req.user!.login, "", "renovate_bot",
      bot ? `Renovate bot set to ${bot}` : "Renovate bot cleared", undefined, "app");
    res.json({ renovateBot: updated.renovateBot ?? null });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "renovate") });
  }
});

export default router;
