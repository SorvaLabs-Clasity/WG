import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { sendIfPermissionDenied } from "../utils/permissionError";
import { fetchAllCursorPages } from "../utils/cursorPages";
import { fetchRenovatePrs } from "../services/renovateService";
import { getOrgConfig, updateRenovateBot } from "../services/orgConfigService";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { mapAlert, fetchOrgDependencyAlerts, fetchRepoAlertStatus , fetchRepoFixStatus} from "../services/dependencyService";
import { isValidRepoName } from "../utils/validation";
import {
  saveDependencySnapshot, readDependencySnapshot, isFresh,
} from "../services/dependencySnapshot";
import { mockCleanAlert, mockDisabledAlert } from "../services/dependencyMarkers";
import { buildDependencyView } from "../services/dependencyView";
import { fetchDependabotPrCounts } from "../services/dependabotPrs";

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
    await saveDependencySnapshot(await buildDependencyView(octokit, org));
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
    const counts = await fetchDependabotPrCounts(
      async (q, page) => {
        const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
          q, per_page: 100, page, advanced_search: "true",
        });
        return { items: r.data?.items ?? [] };
      },
      getOrg(),
    );

    // Null stays null across the wire. A client shown {} would render every
    // repository as having no open pull requests, which is a finding, and
    // nobody established it.
    res.json({ counts: counts ? Object.fromEntries(counts) : null });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/dependencies/age", async (_req: Request, res: Response) => {
  try {
    const stored = await readDependencySnapshot();
    res.json({
      computedAt: stored?.computedAt ?? null,
      fresh: isFresh(stored),
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

    /**
     * The stored answer, when there is one and it is recent.
     *
     * Served without waiting, and a fresh sweep started behind the reader so
     * the next open is current. The alternative is what this replaced: a tab
     * that takes as long as an org-wide sweep every time the app is launched,
     * because the in-memory cache belongs to a process that has just started.
     */
    if (wholeOrg) {
      const stored = await readDependencySnapshot();
      if (stored) {
        res.json(applyFilters(stored.alerts, severityFilter));
        if (!isFresh(stored)) {
          // Deliberately not awaited. The reader already has an answer, and
          // making them wait for the next one is the delay this exists to
          // remove. Failures are logged inside.
          void refreshDependencySnapshot(octokit, org);
        }
        return;
      }
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
      allAlerts = await buildDependencyView(octokit, org);
    }

    // Stored before filtering, so the row backs every view rather than the one
    // that happened to be asked for first.
    if (wholeOrg) await saveDependencySnapshot(allAlerts);

    res.json(applyFilters(allAlerts, severityFilter));
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
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
    void refreshDependencySnapshot(octokit, org);

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
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
    void refreshDependencySnapshot(octokit, org);

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
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
router.post("/dependencies/bulk", async (req: Request, res: Response) => {
  const token = req.user?.accessToken;
  if (!token) return res.status(401).json({ error: "No GitHub token provided" });

  const { repos, action } = req.body ?? {};
  const list = Array.isArray(repos)
    ? repos.filter((r: unknown) => typeof r === "string" && r.length > 0 && r.length <= 200)
    : [];
  const actions = ["alerts-on", "alerts-off", "fixes-on", "fixes-off"];
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
    void refreshDependencySnapshot(octokit, getOrg());

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

    // Shares the sweep with the tab above and with the alarm evaluator, which
    // also brings the 400 tolerance here. This endpoint caught 403 and 404 but
    // not 400, the same rejected-pagination failure that blanked the
    // Dependabot tab would have turned this summary into a 500.
    const sweep = await fetchOrgDependencyAlerts(octokit, org);
    if (sweep.degraded) {
      return res.json({ critical: 0, high: 0, medium: 0, low: 0, repos_with_vulns: 0 });
    }

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    const reposWithVulns = new Set<string>();

    for (const alert of sweep.alerts) {
      // GitHub says "moderate" where this app says "medium". Counting only the
      // app's spelling meant every moderate alert fell through `severity in
      // counts` and was reported in no severity at all, the org's totals were
      // short by however many moderates it had, in the reassuring direction.
      const severity = alert.severity === "moderate" ? "medium" : alert.severity;
      if (severity in counts) {
        counts[severity as keyof typeof counts]++;
      }
      if (alert.repo && alert.repo !== "unknown") {
        reposWithVulns.add(alert.repo);
      }
    }

    res.json({
      ...counts,
      repos_with_vulns: reposWithVulns.size,
    });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
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
    const result = await fetchRenovatePrs(
      async (q, page) => {
        const r: any = await (octokit as any).rest.search.issuesAndPullRequests({
          q, per_page: 100, page, advanced_search: "true",
        });
        return { items: r.data?.items ?? [] };
      },
      getOrg(), bot,
    );
    res.json({ configured: true, ...result });
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
