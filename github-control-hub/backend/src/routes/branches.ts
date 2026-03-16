import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit, getOrg } from "../github/client";
import { listBranches, createBranch, deleteBranch, renameBranch } from "../services/branchService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";

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
    await logActivity("branch.create", req.user!.login, req.params.repo, branchName, `Created from ${baseBranch}`, undefined, "app", undefined, undefined, {
      undoPayload: { action: "delete_branch", params: { repo: req.params.repo, branch: branchName, baseBranch } },
    });
    res.status(201).json({ message: `Branch ${branchName} created` });
  } catch (err) {
    const errMsg = sanitizeError(err, "branches");
    await logActivity("branch.create", req.user!.login, req.params.repo, branchName, `Failed to create branch "${branchName}"`, undefined, "app", undefined, undefined, {
      failed: true, errorMessage: errMsg,
      retryPayload: { action: "create_branch", params: { repo: req.params.repo, branch: branchName, baseBranch } },
    });
    res.status(500).json({ error: errMsg });
  }
});

router.delete(
  "/:repo/branches/:branch",
  async (req: Request<{ repo: string; branch: string }>, res: Response) => {
    try {
      const octokit = createOctokit(req.user!.accessToken);
      let sha: string | undefined;
      try {
        const { data: ref } = await octokit.rest.git.getRef({ owner: getOrg(), repo: req.params.repo, ref: `heads/${req.params.branch}` });
        sha = ref.object.sha;
      } catch { /* best effort */ }
      await deleteBranch(octokit, req.params.repo, req.params.branch);
      await logActivity("branch.delete", req.user!.login, req.params.repo, req.params.branch, undefined, undefined, "app", undefined, undefined, {
        undoPayload: { action: "recreate_branch", params: { repo: req.params.repo, branch: req.params.branch, sha } },
      });
      res.json({ message: `Branch ${req.params.branch} deleted` });
    } catch (err) {
      console.error("Error deleting branch:", err);
      res.status(500).json({ error: "Failed to delete branch" });
    }
  }
);

router.patch(
  "/:repo/branches/:branch/rename",
  async (req: Request<{ repo: string; branch: string }>, res: Response) => {
    const { newName } = req.body as { newName?: string };
    if (!newName) {
      res.status(400).json({ error: "newName is required" });
      return;
    }
    try {
      const octokit = createOctokit(req.user!.accessToken);
      await renameBranch(octokit, req.params.repo, req.params.branch, newName);
      await logActivity("branch.rename", req.user!.login, req.params.repo, req.params.branch, `Renamed to ${newName}`, undefined, "app", undefined, undefined, {
        undoPayload: { action: "rename_branch", params: { repo: req.params.repo, from: newName, to: req.params.branch } },
      });
      res.json({ message: `Branch renamed from "${req.params.branch}" to "${newName}"` });
    } catch (err) {
      const errMsg = sanitizeError(err, "branches");
      await logActivity("branch.rename", req.user!.login, req.params.repo, req.params.branch, `Failed to rename branch "${req.params.branch}"`, undefined, "app", undefined, undefined, {
        failed: true, errorMessage: errMsg,
        retryPayload: { action: "rename_branch", params: { repo: req.params.repo, from: req.params.branch, to: newName } },
      });
      res.status(500).json({ error: errMsg });
    }
  }
);

export default router;
