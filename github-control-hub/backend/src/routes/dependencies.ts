import { Router, Request, Response } from "express";
import { createOctokit, getOrg, getSystemToken } from "../github/client";
import { listRepos } from "../services/repoService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";
import { sendIfRateLimited } from "../utils/rateLimit";
import { sendIfPermissionDenied } from "../utils/permissionError";

const router = Router();

/**
 * Every open alert, not the first hundred.
 *
 * All three Dependabot calls in this file asked for `per_page: 100` and used
 * the page they got back. Past a hundred open alerts an organisation
 * under-counted every severity and under-listed every repository — silently,
 * and in the direction that reads as good news. "12 critical" when the answer
 * is 300 is worse than showing nothing, and it is the same failure
 * MissingGraphDataError exists to prevent on the graph checks.
 *
 * Shaped like listRepos' loop rather than octokit.paginate, because that loop
 * is the pattern already used everywhere else here, and because createOctokit
 * disables throttle retries — a rate-limited page throws, which every caller
 * below already handles.
 *
 * Exported for repro-dependencies.ts.
 */
export async function fetchAllPages(
  fetchPage: (page: number) => Promise<{ data: any[] }>,
): Promise<any[]> {
  const all: any[] = [];
  let page = 1;

  while (true) {
    const { data } = await fetchPage(page);
    if (data.length === 0) break;
    all.push(...data);
    // A short page is the last page. Asking for one more would cost a request
    // per call to learn nothing.
    if (data.length < 100) break;
    page++;
  }

  return all;
}

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
      const data = await fetchAllPages((page) =>
        octokit.rest.dependabot.listAlertsForRepo({
          owner: org,
          repo: repoFilter,
          state: "open",
          per_page: 100,
          page,
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
      try {
        const data = await fetchAllPages((page) =>
          octokit.rest.dependabot.listAlertsForOrg({
            org,
            state: "open",
            per_page: 100,
            page,
          })
        );
        allAlerts = data.map((a: any) => mapAlert(a, a.repository?.name || "unknown", org));
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404) {
          throw err;
        }
      }
      
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

    let allAlerts: any[] = [];
    try {
      allAlerts = await fetchAllPages((page) =>
        octokit.rest.dependabot.listAlertsForOrg({
          org,
          state: "open",
          per_page: 100,
          page,
        })
      );
    } catch (err: any) {
      if (err.status === 403 || err.status === 404) {
        return res.json({ critical: 0, high: 0, medium: 0, low: 0, repos_with_vulns: 0 });
      }
      throw err;
    }

    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    const reposWithVulns = new Set<string>();

    for (const alert of allAlerts) {
      const severity = alert.security_advisory?.severity || alert.security_vulnerability?.severity || "low";
      if (severity in counts) {
        counts[severity as keyof typeof counts]++;
      }
      if (alert.repository?.name) {
        reposWithVulns.add(alert.repository.name);
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

function mapAlert(alert: any, repoName: string, orgName: string) {
  const advisory = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};

  return {
    id: `dep-${alert.number}`,
    repo: repoName,
    org: orgName,
    dependency: vuln.package?.name || advisory.summary || "unknown",
    severity: advisory.severity || vuln.severity || "low",
    cve: advisory.cve_id || (advisory.identifiers || []).find((i: any) => i.type === "CVE")?.value || "",
    ecosystem: vuln.package?.ecosystem || "",
    vulnerable_version: vuln.vulnerable_version_range || "",
    patched_version: vuln.first_patched_version?.identifier || null,
    detected_at: alert.created_at || new Date().toISOString(),
  };
}

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
