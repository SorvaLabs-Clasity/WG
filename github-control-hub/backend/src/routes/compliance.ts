import { Router, Request, Response } from "express";
import { calculateRepoCompliance } from "../services/complianceService";
import { createOctokit, getOrg } from "../github/client";
import { getComplianceConfig, updateComplianceConfig } from "../services/complianceConfigService";

const router = Router();

router.get("/config", async (_req: Request, res: Response) => {
  try {
    const config = await getComplianceConfig();
    res.json(config);
  } catch (error: any) {
    console.error("Error fetching compliance config:", error);
    res.status(500).json({ error: error.message });
  }
});

router.put("/config", async (req: Request, res: Response) => {
  try {
    const { rules } = req.body;
    if (!Array.isArray(rules)) {
      return res.status(400).json({ error: "'rules' must be an array" });
    }
    const config = await updateComplianceConfig(rules);
    res.json(config);
  } catch (error: any) {
    console.error("Error updating compliance config:", error);
    res.status(500).json({ error: error.message });
  }
});

router.get("/dashboard", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken || process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);
    const org = getOrg();

    const { data: repos } = await octokit.rest.repos.listForOrg({
      org,
      sort: "updated",
      per_page: 20,
    });

    const scores = await Promise.all(
      repos.map((r: any) => calculateRepoCompliance(octokit, r.name, token))
    );

    res.json(scores);
  } catch (error: any) {
    console.error("Error generating compliance dashboard:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
