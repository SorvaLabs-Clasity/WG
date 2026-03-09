import { Router, Request, Response } from "express";
import { Octokit } from "octokit";
import { createOctokit, getOrg } from "../github/client";

const router = Router();

// In a real app, this would hit GitHub's Dependabot API or query a database
// GET /api/security/dependencies
router.get("/dependencies", async (req: Request, res: Response) => {
  try {
    let token = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
    
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    // Mock response for now, but real implementation would fetch Dependabot alerts
    // using octokit.rest.dependabot.listAlertsForOrg({ org })
    const alerts = [
      {
        id: "dep-1",
        repo: "payments-api",
        dependency: "lodash",
        severity: "high",
        cve: "CVE-2021-23337",
        ecosystem: "npm",
        vulnerable_version: "< 4.17.21",
        patched_version: "4.17.21",
        detected_at: new Date(Date.now() - 86400000).toISOString(),
      },
      {
        id: "dep-2",
        repo: "payments-api",
        dependency: "axios",
        severity: "critical",
        cve: "CVE-2023-45857",
        ecosystem: "npm",
        vulnerable_version: "< 1.6.0",
        patched_version: "1.6.0",
        detected_at: new Date(Date.now() - 172800000).toISOString(),
      },
      {
        id: "dep-3",
        repo: "auth-service",
        dependency: "log4j",
        severity: "critical",
        cve: "CVE-2021-44228",
        ecosystem: "maven",
        vulnerable_version: "< 2.15.0",
        patched_version: "2.15.0",
        detected_at: new Date(Date.now() - 345600000).toISOString(),
      },
      {
        id: "dep-4",
        repo: "web-platform",
        dependency: "react-scripts",
        severity: "low",
        cve: "CVE-2022-24302",
        ecosystem: "npm",
        vulnerable_version: "< 5.0.1",
        patched_version: "5.0.1",
        detected_at: new Date(Date.now() - 432000000).toISOString(),
      },
      {
        id: "dep-disabled",
        repo: "infrastructure",
        dependency: "",
        severity: "low",
        cve: "",
        ecosystem: "",
        vulnerable_version: "",
        patched_version: null,
        detected_at: new Date().toISOString(),
        disabled: true,
      }
    ];

    res.json(alerts);
  } catch (error: any) {
    console.error("Error fetching dependencies:", error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/security/summary
router.get("/summary", async (req: Request, res: Response) => {
  try {
    // This is mocked for demonstration
    res.json({
      critical: 3,
      high: 12,
      medium: 20,
      low: 45,
      repos_with_vulns: 7,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;