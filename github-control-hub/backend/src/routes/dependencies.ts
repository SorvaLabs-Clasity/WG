import { Router, Request, Response } from "express";
import { createOctokit, getOrg } from "../github/client";

const router = Router();

router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken || process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
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
      allAlerts = data.map((a: any) => mapAlert(a, repoFilter));
    } else {
      try {
        const { data } = await octokit.rest.dependabot.listAlertsForOrg({
          org,
          state: "open",
          per_page: 100,
        });
        allAlerts = data.map((a: any) => mapAlert(a, a.repository?.name || "unknown"));
      } catch (err: any) {
        if (err.status === 403 || err.status === 404) {
          return res.json([]);
        }
        throw err;
      }
    }

    if (severityFilter) {
      allAlerts = allAlerts.filter(a => a.severity === severityFilter);
    }

    res.json(allAlerts);
  } catch (error: any) {
    console.error("Error fetching dependencies:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/summary", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken || process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
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
    console.error("Error fetching dependency summary:", error);
    res.status(500).json({ error: error.message });
  }
});

function mapAlert(alert: any, repoName: string) {
  const advisory = alert.security_advisory || {};
  const vuln = alert.security_vulnerability || {};

  return {
    id: `dep-${alert.number}`,
    repo: repoName,
    dependency: vuln.package?.name || advisory.summary || "unknown",
    severity: advisory.severity || vuln.severity || "low",
    cve: advisory.cve_id || (advisory.identifiers || []).find((i: any) => i.type === "CVE")?.value || "",
    ecosystem: vuln.package?.ecosystem || "",
    vulnerable_version: vuln.vulnerable_version_range || "",
    patched_version: vuln.first_patched_version?.identifier || null,
    detected_at: alert.created_at || new Date().toISOString(),
  };
}

export default router;
