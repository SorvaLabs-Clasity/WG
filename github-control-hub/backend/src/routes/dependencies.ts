import { Router, Request, Response } from "express";
import { createOctokit, getOrg } from "../github/client";
import { listRepos } from "../services/repoService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";

const router = Router();

router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    const token = process.env.SYSTEM_GITHUB_TOKEN || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    const repoFilter = req.query.repo as string | undefined;
    const severityFilter = req.query.severity as string | undefined;

    let allAlerts: any[] = [];

    if (repoFilter) {
      const { data } = await octokit.rest.dependabot.listAlertsForRepo({
        owner: org,
        repo: repoFilter,
        state: "open",
        per_page: 100,
      });
      allAlerts = data.map((a: any) => mapAlert(a, repoFilter, org));
      
      // If we are filtering by repo and there are no alerts, let's just check if it's enabled
      if (allAlerts.length === 0) {
        try {
          await octokit.rest.repos.checkVulnerabilityAlerts({ owner: org, repo: repoFilter });
        } catch (err: any) {
          if (err.status === 404) {
            allAlerts.push(mockDisabledAlert(repoFilter, org));
          }
        }
      }
    } else {
      try {
        const { data } = await octokit.rest.dependabot.listAlertsForOrg({
          org,
          state: "open",
          per_page: 100,
        });
        allAlerts = data.map((a: any) => mapAlert(a, a.repository?.name || "unknown", org));
      } catch (err: any) {
        if (err.status === 403 && /rate limit/i.test(err?.message || "")) {
          const reset = err?.response?.headers?.["x-ratelimit-reset"];
          return res.status(429).json({ error: "GitHub API rate limit exceeded. Please wait a few minutes and try again.", resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : undefined });
        }
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
    if (error?.status === 403 && /rate limit/i.test(error?.message || "")) {
      const reset = error?.response?.headers?.["x-ratelimit-reset"];
      return res.status(429).json({ error: "GitHub API rate limit exceeded. Please wait a few minutes and try again.", resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : undefined });
    }
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/enable", async (req: Request, res: Response) => {
  try {
    const token = process.env.SYSTEM_GITHUB_TOKEN || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    await octokit.rest.repos.enableVulnerabilityAlerts({
      owner: org,
      repo,
    });

    await logActivity("dependabot.enable" as any, req.user?.login || "system", repo, "Dependabot",
      `Enabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "disable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.post("/dependencies/disable", async (req: Request, res: Response) => {
  try {
    const token = process.env.SYSTEM_GITHUB_TOKEN || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const { repo } = req.body;
    if (!repo) {
      return res.status(400).json({ error: "Repo name is required" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    await octokit.rest.repos.disableVulnerabilityAlerts({
      owner: org,
      repo,
    });

    await logActivity("dependabot.disable" as any, req.user?.login || "system", repo, "Dependabot",
      `Disabled Dependabot vulnerability alerts for "${repo}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "enable_dependabot", params: { repo } } }
    );

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error, "dependencies") });
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const token = process.env.SYSTEM_GITHUB_TOKEN || req.user?.accessToken;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    let allAlerts: any[] = [];
    try {
      const { data } = await octokit.rest.dependabot.listAlertsForOrg({
        org,
        state: "open",
        per_page: 100,
      });
      allAlerts = data;
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
