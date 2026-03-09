import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit } from "../github/client";
import { protectBranch, getProtection, listRulesets, getAllProtections } from "../services/branchService";
import { logActivity } from "../services/activityService";

type RepoAndBranch = { repo: string; branch: string };

const router = Router();

router.get("/:repo/rulesets", async (req: Request<{ repo: string }>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const rulesets = await listRulesets(octokit, req.params.repo);
    res.json(rulesets);
  } catch (err) {
    console.error("Error getting rulesets:", err);
    res.status(500).json({ error: "Failed to get rulesets" });
  }
});

router.get("/:repo/protections", async (req: Request<{ repo: string }>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const protections = await getAllProtections(octokit, req.params.repo);
    res.json(protections);
  } catch (err) {
    console.error("Error getting all protections:", err);
    res.status(500).json({ error: "Failed to get all branch protections" });
  }
});

router.get("/:repo/protection/:branch", async (req: Request<RepoAndBranch>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const protection = await getProtection(octokit, req.params.repo, req.params.branch);
    if (!protection) {
      res.status(404).json({ error: "No protection rules found" });
      return;
    }
    res.json(protection);
  } catch (err) {
    console.error("Error getting protection:", err);
    res.status(500).json({ error: "Failed to get branch protection" });
  }
});

router.put("/:repo/protection/:branch", async (req: Request<RepoAndBranch>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const protection = req.body;
    await protectBranch(octokit, req.params.repo, req.params.branch, protection);
    logActivity("branch.protect", req.user!.login, req.params.repo, req.params.branch, "Applied protection rules", {
      new: protection,
    });
    res.json({ message: `Protection applied to ${req.params.branch}` });
  } catch (err) {
    console.error("Error applying protection:", err);
    res.status(500).json({ error: "Failed to apply branch protection" });
  }
});

export default router;
