import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit, getOrg } from "../github/client";
import { protectBranch, getProtection, listRulesets, getAllProtections, deleteProtection, deleteRuleset } from "../services/branchService";
import { logActivity } from "../services/activityService";
import { sanitizeError } from "../utils/errorSanitizer";

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
    const result = await protectBranch(octokit, req.params.repo, req.params.branch, protection);
    const isRuleset = protection.type === "ruleset" || protection.type === "ruleset_json";
    const undoAction = isRuleset ? "delete_ruleset" : "delete_protection";
    const undoParams: Record<string, any> = { repo: req.params.repo, branch: req.params.branch, protectionConfig: protection };
    if (isRuleset && result.rulesetId) undoParams.rulesetId = result.rulesetId;
    if (isRuleset) undoParams.branchNames = [req.params.branch];
    await logActivity("branch.protect", req.user!.login, req.params.repo, req.params.branch, "Applied protection rules", {
      new: protection,
    }, "app", undefined, undefined, {
      undoPayload: { action: undoAction, params: undoParams },
    });
    res.json({ message: `Protection applied to ${req.params.branch}` });
  } catch (err) {
    const errMsg = sanitizeError(err, "protection");
    await logActivity("branch.protect", req.user!.login, req.params.repo, req.params.branch, `Failed to apply protection to "${req.params.branch}"`, undefined, "app", undefined, undefined, {
      failed: true, errorMessage: errMsg,
      retryPayload: { action: "apply_protection", params: { repo: req.params.repo, branch: req.params.branch, protectionConfig: req.body } },
    });
    res.status(500).json({ error: errMsg });
  }
});

router.delete("/:repo/protection/:branch", async (req: Request<RepoAndBranch>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    let protectionConfig: any;
    try {
      protectionConfig = await getProtection(octokit, req.params.repo, req.params.branch);
    } catch { /* best effort */ }
    await deleteProtection(octokit, req.params.repo, req.params.branch);
    await logActivity("branch.unprotect", req.user!.login, req.params.repo, req.params.branch, "Removed branch protection", undefined, "app", undefined, undefined, {
      undoPayload: { action: "restore_protection", params: { repo: req.params.repo, branch: req.params.branch, protectionConfig } },
    });
    res.json({ message: `Protection removed from ${req.params.branch}` });
  } catch (err) {
    console.error("Error deleting protection:", err);
    res.status(500).json({ error: "Failed to delete branch protection" });
  }
});

router.post("/:repo/rulesets/import", async (req: Request<{ repo: string }>, res: Response) => {
  const raw = req.body;
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const { getOrg } = require("../github/client");
    const org = getOrg();

    const { id, source, source_type, node_id, _links, ...payload } = raw;

    await octokit.rest.repos.createRepoRuleset({
      owner: org,
      repo: req.params.repo,
      ...payload,
    });

    await logActivity(
      "repo.ruleset.import",
      req.user!.login,
      req.params.repo,
      payload.name || "Imported ruleset",
      `Imported ruleset "${payload.name}" from JSON`
    );

    res.json({ message: `Ruleset "${payload.name}" imported successfully` });
  } catch (err: any) {
    const ghMsg = err?.response?.data?.message || err?.message || "Unknown error";
    const ghErrors = err?.response?.data?.errors;
    const detail = ghErrors ? ` — ${JSON.stringify(ghErrors)}` : "";
    const errMsg = `Failed to import ruleset: ${ghMsg}${detail}`;
    await logActivity("repo.ruleset.import", req.user!.login, req.params.repo, raw?.name || "Imported ruleset",
      `Failed to import ruleset`, undefined, "app", undefined, undefined, {
      failed: true, errorMessage: errMsg,
      retryPayload: { action: "create_ruleset", params: { repo: req.params.repo, protectionConfig: { type: "ruleset_json", rawJson: raw }, branchNames: [] } },
    });
    res.status(500).json({ error: sanitizeError(err, "protection") });
  }
});

router.delete("/:repo/rulesets/:rulesetId", async (req: Request<{ repo: string; rulesetId: string }>, res: Response) => {
  try {
    const octokit = createOctokit(req.user!.accessToken);
    const org = getOrg();
    let rulesetConfig: any;
    try {
      const { data } = await octokit.rest.repos.getRepoRuleset({ owner: org, repo: req.params.repo, ruleset_id: parseInt(req.params.rulesetId, 10) });
      rulesetConfig = data;
    } catch { /* best effort */ }
    await deleteRuleset(octokit, req.params.repo, parseInt(req.params.rulesetId, 10));
    await logActivity("repo.ruleset.delete", req.user!.login, req.params.repo, rulesetConfig?.name || req.params.rulesetId, "Deleted ruleset", undefined, "app", undefined, undefined, {
      undoPayload: { action: "recreate_ruleset", params: { repo: req.params.repo, rulesetConfig } },
    });
    res.json({ message: `Ruleset ${req.params.rulesetId} deleted` });
  } catch (err) {
    console.error("Error deleting ruleset:", err);
    res.status(500).json({ error: "Failed to delete ruleset" });
  }
});

export default router;
