import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { listRepos } from "../services/repoService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { sendIfPermissionDenied } from "../utils/permissionError";
import { fetchAllCursorPages } from "../utils/cursorPages";
import { mapAlert, fetchOrgDependencyAlerts } from "../services/dependencyService";

const router = Router();

router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    const repoFilter = req.query.repo as string | undefined;
    const severityFilter = req.query.severity as string | undefined;

    let allAlerts: any[] = [];

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
      // one that had vanished, so each case gets its marker — the same
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
      // The alert sweep failing should cost the alerts, not the page. Every
      // repository below is still listed with its Dependabot state, which is
      // most of what this screen is for — so a degraded sweep is tolerated
      // here, and reported rather than thrown. The alarm evaluator reads the
      // same function and treats `degraded` as "no reading", because an alarm
      // must not resolve itself off a sweep that never ran.
      const sweep = await fetchOrgDependencyAlerts(octokit, org);
      allAlerts = sweep.alerts;


      // Also fetch all repos and check if any have dependabot disabled
      const repos = await listRepos(octokit);
      const reposWithAlerts = new Set(allAlerts.map(a => a.repo));
      const reposToCheck = repos.filter(r => !reposWithAlerts.has(r.name));
      
      // Check in batches of 10 to avoid rate limits
      const CHUNK_SIZE = 10;
      for (let i = 0; i < reposToCheck.length; i += CHUNK_SIZE) {
        const chunk = reposToCheck.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (r) => {
          try {
            await octokit.rest.repos.checkVulnerabilityAlerts({ owner: org, repo: r.name });
            allAlerts.push(mockCleanAlert(r.name, org));
          } catch (err: any) {
            if (err.status === 404) {
              allAlerts.push(mockDisabledAlert(r.name, org));
            }
          }
        }));
      }
    }

    if (severityFilter) {
      allAlerts = allAlerts.filter(a => a.severity === severityFilter);
    }

    res.json(allAlerts);
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/enable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo — act as the user so GitHub authorises it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    try {
      await octokit.rest.repos.enableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "enable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.enable" as any, req.user?.login || "system", repo, "Dependabot",
      `Enabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "disable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/disable", async (req: Request, res: Response) => {
  try {
    // A write against a specific repo — act as the user so GitHub authorises it.
    const token = req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    try {
      await octokit.rest.repos.disableVulnerabilityAlerts({ owner: org, repo });
    } catch (err) {
      if (sendIfPermissionDenied(res, err, req.user!.login, "disable Dependabot alerts", repo)) return;
      throw err;
    }

    await logActivity("dependabot.disable" as any, req.user?.login || "system", repo, "Dependabot",
      `Disabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "enable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    if (sendIfRateLimited(res, error)) return;
    if (sendIfRateLimited(res, error)) return;
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const token = getSystemToken() || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    // Shares the sweep with the tab above and with the alarm evaluator, which
    // also brings the 400 tolerance here. This endpoint caught 403 and 404 but
    // not 400 — the same rejected-pagination failure that blanked the
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
      // counts` and was reported in no severity at all — the org's totals were
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

function mockDisabledAlert(repoName: string, orgName: string) {
  return {
    id: `disabled-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "Dependabot alerts disabled",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    disabled: true
  };
}

function mockCleanAlert(repoName: string, orgName: string) {
  return {
    id: `clean-${repoName}`,
    repo: repoName,
    org: orgName,
    dependency: "No vulnerabilities found",
    severity: "low",
    cve: "",
    ecosystem: "",
    vulnerable_version: "",
    patched_version: null,
    detected_at: new Date().toISOString(),
    clean: true
  };
}

export default router;
