import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
} from "../services/templateService";
import { getExclusion, listExclusions } from "../services/exclusionService";
import { logActivity } from "../services/activityService";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  res.json(await listTemplates());
});

router.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const template = await getTemplate(req.params.id);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(template);
});

router.post("/", async (req: Request, res: Response) => {
  const { name, description, branches, tags, pushRules, autoApplyOnNewRepo, exclusionLists } = req.body;
  if (!name || !branches?.length) {
    res.status(400).json({ error: "name and at least one branch rule are required" });
    return;
  }

  const allExclusions = await listExclusions();
  const forcedIds = allExclusions
    .filter(e => e.forceOnNewTemplates)
    .map(e => e.id);
  const mergedExclusions = Array.from(new Set([...(exclusionLists ?? []), ...forcedIds]));

  const template = await createTemplate(
    {
      name,
      description: description ?? "",
      branches,
      tags: Array.isArray(tags) ? tags : undefined,
      pushRules: Array.isArray(pushRules) ? pushRules : undefined,
      autoApplyOnNewRepo: autoApplyOnNewRepo ?? false,
      exclusionLists: mergedExclusions,
      createdBy: req.user!.login,
    },
    req.user!.login
  );

  res.status(201).json(template);
});

router.put("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const { name, description, branches, tags, pushRules, autoApplyOnNewRepo, exclusionLists } = req.body;
  const data: Record<string, any> = { name, description, branches, tags, pushRules, autoApplyOnNewRepo, exclusionLists };

  const allExclusions = data.exclusionLists ? await listExclusions() : [];
  if (data.exclusionLists) {
    const templateId = req.params.id;
    const forcedIds = allExclusions
      .filter(e => e.forceOnNewTemplates || (e.forceTemplateIds || []).includes(templateId))
      .map(e => e.id);
    data.exclusionLists = Array.from(new Set([...data.exclusionLists, ...forcedIds]));
  }

  const exclusionNameMap = new Map<string, string>();
  for (const e of allExclusions) {
    exclusionNameMap.set(e.id, e.name);
  }

  const updated = await updateTemplate(req.params.id, data, req.user!.login, exclusionNameMap);
  if (!updated) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(updated);
});

router.delete("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const deleted = await deleteTemplate(req.params.id, req.user!.login);
  if (!deleted) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json({ message: "Template deleted" });
});

router.post("/:id/apply", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { repos } = req.body;
    if (!Array.isArray(repos) || repos.length === 0) {
      res.status(400).json({ error: "repos array is required" });
      return;
    }

    const template = await getTemplate(req.params.id);
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    const excludedRepos = new Set<string>();
    if (template.exclusionLists && template.exclusionLists.length > 0) {
      for (const listId of template.exclusionLists) {
        const excl = await getExclusion(listId);
        if (excl) {
          excl.repos.forEach(r => excludedRepos.add(r));
        }
      }
    }

    const octokit = createOctokit(process.env.SYSTEM_GITHUB_TOKEN || req.user!.accessToken);
    const merged = { created: [] as string[], protected: [] as string[], errors: [] as string[], skipped: [] as string[], conflicts: [] as any[] };
    const actor = req.user!.login;

    const nonExcludedRepos = repos.filter((r: string) => !excludedRepos.has(r));
    repos.filter((r: string) => excludedRepos.has(r)).forEach((r: string) => merged.skipped.push(r));

    const parentEntry = await logActivity(
      "template.apply", actor,
      nonExcludedRepos.length === 1 ? nonExcludedRepos[0] : "*",
      template.name,
      `Applied template "${template.name}" to ${nonExcludedRepos.length} repo${nonExcludedRepos.length !== 1 ? 's' : ''}`
    );
    const parentId = parentEntry.id;

    for (const repo of nonExcludedRepos) {
      const repoEntry = await logActivity(
        "template.apply.repo" as any, actor, repo, template.name,
        `Applied template "${template.name}" to ${repo}`,
        undefined, "app", undefined, undefined,
        { parentId }
      );

      try {
        const result = await applyTemplate(octokit, req.params.id, repo, actor, repoEntry.id);
        merged.created.push(...result.created.map((b: string) => `${repo}:${b}`));
        merged.protected.push(...result.protected.map((b: string) => `${repo}:${b}`));
        merged.errors.push(...result.errors.map((e: string) => `[${repo}] ${e}`));
        if (result.conflicts.length > 0) {
          merged.conflicts.push(...result.conflicts);
        }
      } catch (e) {
        merged.errors.push(`[${repo}] ${(e as Error).message}`);
      }
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "templates") });
  }
});

export default router;
