import { Router, Request, Response } from "express";
import { createOctokit, getSystemToken } from "../github/client";
import { listRepos } from "../services/repoService";
import { getRepoDetails } from "../services/repoDetailsService";
import { isValidRepoName } from "../utils/validation";

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

/** Full detail for one repo — powers the Knowledge Center panel. */
router.get("/:repo/details", async (req: Request<{ repo: string }>, res: Response) => {
  const { repo } = req.params;
  if (!isValidRepoName(repo)) {
    res.status(400).json({ error: "Invalid repository name" });
    return;
  }
  try {
    // Prefer the App token so the panel sees the same repos the rest of the app
    // manages, falling back to the caller's own grant.
    const octokit = createOctokit(getSystemToken() || req.user!.accessToken);
    res.json(await getRepoDetails(octokit, repo));
  } catch (err: any) {
    if (err?.status === 404) {
      res.status(404).json({ error: "Repository not found" });
      return;
    }
    console.error(`Error loading details for "${repo}":`, err?.message ?? err);
    res.status(500).json({ error: "Failed to load repository details" });
  }
});

export default router;
