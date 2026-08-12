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
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";

const router = Router();

/**
 * An exclusion list decides which repositories a template skips, so editing one
 * silently removes protection from whatever it names — without touching the
 * template or any repository directly. That is a change to the org's security
 * posture and belongs behind the same gate as the templates it modifies.
 *
 * Reading stays open: everyone should be able to see what is exempt and why.
 */
async function refusedExclusionChange(res: Response, login: string, verb: string): Promise<boolean> {
  if (await isControlHubAdmin(login)) return false;
  res.status(403).json({
    error: `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can ${verb} ` +
      `exclusion lists, because excluding a repository stops templates protecting it.`,
    code: "CONTROL_HUB_ADMIN_REQUIRED",
  });
  return true;
}

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
  if (await refusedExclusionChange(res, req.user!.login, "create")) return;

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
  if (await refusedExclusionChange(res, req.user!.login, "edit")) return;

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
  if (await refusedExclusionChange(res, req.user!.login, "delete")) return;

  const deleted = await deleteExclusion(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  res.json({ message: "Exclusion list deleted" });
});

export default router;
