import { Router } from "express";
import type { Request, Response } from "express";
import {
  listExclusions,
  getExclusion,
  createExclusion,
  updateExclusion,
  deleteExclusion,
  resolveExcludedRepos,
  normalizeExclusion,
} from "../services/exclusionService";
import { createOctokit, getSystemToken } from "../github/client";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listExclusions());
});

router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const exclusion = await getExclusion(req.params.id);
  if (!exclusion) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json(exclusion);
});

/** Resolve patterns against live org repos and return the breakdown. */
router.get("/:id/resolved-repos", async (req: Request<{ id: string }>, res: Response) => {
  const exclusion = await getExclusion(req.params.id);
  if (!exclusion) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }

  const token = getSystemToken() || req.user?.accessToken;
  if (!token) {
    res.status(503).json({ error: "No GitHub token available" });
    return;
  }

  const octokit = createOctokit(token);
  const result = await resolveExcludedRepos(normalizeExclusion(exclusion), octokit);

  res.json({
    explicitRepos: result.explicitRepos,
    patternMatches: result.patternMatches,
    whitelistedRepos: result.whitelistedRepos,
    effectiveRepos: Array.from(result.effectiveRepos),
  });
});

router.post("/", async (req: Request, res: Response) => {
  const { name, description, repos, patterns, patternWhitelist, forceTemplateIds, forceOnNewTemplates } = req.body;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const exclusion = await createExclusion(
    {
      name,
      description: description ?? "",
      repos: repos ?? [],
      patterns: patterns ?? [],
      patternWhitelist: patternWhitelist ?? [],
      forceTemplateIds: forceTemplateIds ?? [],
      forceOnNewTemplates: forceOnNewTemplates ?? false,
      createdBy: req.user!.login,
    },
    req.user!.login
  );

  res.status(201).json(exclusion);
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { name, description, repos, patterns, patternWhitelist, forceTemplateIds, forceOnNewTemplates } = req.body;
  const updated = await updateExclusion(
    req.params.id,
    { name, description, repos, patterns, patternWhitelist, forceTemplateIds, forceOnNewTemplates },
    req.user!.login
  );
  if (!updated) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const deleted = await deleteExclusion(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json({ message: "Exclusion list deleted" });
});

export default router;
