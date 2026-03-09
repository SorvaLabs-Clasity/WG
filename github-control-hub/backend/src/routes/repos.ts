import { Router, Request, Response } from "express";
import { createOctokit } from "../github/client";
import { listRepos } from "../services/repoService";

const router = Router();

router.get("/", async (req: Request, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const repos = await listRepos(octokit);
    res.json(repos);
  } catch (err) {
    console.error("Error listing repos:", err);
    res.status(500).json({ error: "Failed to list repositories" });
  }
});

export default router;
