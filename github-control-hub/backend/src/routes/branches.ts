import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit } from "../github/client";
import { listBranches, createBranch, deleteBranch } from "../services/branchService";
import { logActivity } from "../services/activityService";

const router = Router();

router.get("/:repo/branches", async (req: Request<{ repo: string }>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const branches = await listBranches(octokit, req.params.repo);
    res.json(branches);
  } catch (err) {
    console.error("Error listing branches:", err);
    res.status(500).json({ error: "Failed to list branches" });
  }
});

router.post("/:repo/branches", async (req: Request<{ repo: string }>, res: Response) => {
  const { branchName, baseBranch } = req.body as {
    branchName?: string;
    baseBranch?: string;
  };

  if (!branchName || !baseBranch) {
    res.status(400).json({ error: "branchName and baseBranch are required" });
    return;
  }

  try {
    const octokit = createOctokit(req.user!.accessToken);
    await createBranch(octokit, req.params.repo, branchName, baseBranch);
    await logActivity("branch.create", req.user!.login, req.params.repo, branchName, `Created from ${baseBranch}`);
    res.status(201).json({ message: `Branch ${branchName} created` });
  } catch (err) {
    console.error("Error creating branch:", err);
    res.status(500).json({ error: "Failed to create branch" });
  }
});

router.delete(
  "/:repo/branches/:branch",
  async (req: Request<{ repo: string; branch: string }>, res: Response) => {
    try {
      const octokit = createOctokit(req.user!.accessToken);
      await deleteBranch(octokit, req.params.repo, req.params.branch);
      await logActivity("branch.delete", req.user!.login, req.params.repo, req.params.branch);
      res.json({ message: `Branch ${req.params.branch} deleted` });
    } catch (err) {
      console.error("Error deleting branch:", err);
      res.status(500).json({ error: "Failed to delete branch" });
    }
  }
);

export default router;
