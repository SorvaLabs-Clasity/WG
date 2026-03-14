import { Router, Request, Response } from "express";
import { createOctokit, getOrg } from "../github/client";
import { getComplianceConfig, updateComplianceConfig } from "../services/complianceConfigService";
import { getCachedScores, refreshAll, refreshRepo } from "../services/complianceCacheService";

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

router.get("/dashboard", async (_req: Request, res: Response) => {
  try {
    const scores = await getCachedScores();
    res.json(scores);
  } catch (error: any) {
    console.error("Error fetching cached compliance scores:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/dashboard/refresh", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken || process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }
    const scores = await refreshAll(token);
    res.json(scores);
  } catch (error: any) {
    if (error?.status === 403 && /rate limit/i.test(error?.message || "")) {
      return res.status(429).json({ error: "GitHub API rate limit exceeded. Please try again later." });
    }
    console.error("Error refreshing compliance dashboard:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/dashboard/refresh/:repo", async (req: Request, res: Response) => {
  try {
    const token = req.user?.accessToken || process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }
    const score = await refreshRepo(token, req.params.repo as string);
    res.json(score);
  } catch (error: any) {
    if (error?.status === 403 && /rate limit/i.test(error?.message || "")) {
      return res.status(429).json({ error: "GitHub API rate limit exceeded. Please try again later." });
    }
    console.error(`Error refreshing compliance for ${req.params.repo}:`, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
