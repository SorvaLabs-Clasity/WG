import { Router, Request, Response } from "express";
import { calculateRepoCompliance } from "../services/complianceService";
import { createOctokit } from "../github/client";

const router = Router();

// GET /api/compliance/dashboard
router.get("/dashboard", async (req: Request, res: Response) => {
  try {
    // Determine token based on header or env
    let token = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.substring(7);
    }
    
    if (!token) {
      return res.status(401).json({ error: "No GitHub token provided" });
    }

    const octokit = createOctokit(token);

    // Get list of repos
    const { data: repos } = await octokit.rest.repos.listForOrg({
      org: process.env.GITHUB_ORG || "default-org",
      sort: "updated",
      per_page: 5, // Limiting for performance in demo. In real app, paginate.
    });

    const scores = await Promise.all(
      repos.map(r => calculateRepoCompliance(octokit, r.name))
    );

    res.json(scores);
  } catch (error: any) {
    console.error("Error generating compliance dashboard:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
