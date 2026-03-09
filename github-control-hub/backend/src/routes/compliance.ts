import { Router, Request, Response } from "express";
import { calculateRepoCompliance } from "../services/complianceService";
import { createOctokit, getOrg } from "../github/client";

const router = Router();

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
      repos.map((r: any) => calculateRepoCompliance(octokit, r.name))
    );

    res.json(scores);
  } catch (error: any) {
    console.error("Error generating compliance dashboard:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
