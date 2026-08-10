import { Router } from "express";
import type { Request, Response } from "express";
import { createOctokit, getSystemToken } from "../github/client";
import { sanitizeError } from "../utils/errorSanitizer";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplate,
} from "../services/templateService";
import { getExclusion, listExclusions, resolveExcludedReposFromIds } from "../services/exclusionService";
import { logActivity, updateActivityOutcome } from "../services/activityService";
import { isControlHubAdmin, CONTROL_HUB_ADMIN_TEAM } from "../services/authorizationService";
import { isPermissionDenied, permissionMessage } from "../utils/permissionError";

const router = Router();

/**
 * Auto-apply silently protects every repository created from now on, so it is
 * not something an ordinary member should be able to switch on. Unlike applying
 * a template — which GitHub authorises directly, because that call is made with
 * the user's own token — this setting has no GitHub-side equivalent to check.
 */
async function denyAutoApplyChange(login: string): Promise<string | null> {
  if (await isControlHubAdmin(login)) return null;
  return `Only members of the "${CONTROL_HUB_ADMIN_TEAM}" team (or organization owners) can change ` +
    `auto-apply on new repositories, because it affects every repository created from now on.`;
}

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

  if (autoApplyOnNewRepo) {
    const denied = await denyAutoApplyChange(req.user!.login);
    if (denied) {
      res.status(403).json({ error: denied, code: "CONTROL_HUB_ADMIN_REQUIRED" });
      return;
    }
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

  // Gate only an actual change to the flag. The edit form round-trips the whole
  // template, so a non-admin editing an unrelated field resends the existing
  // value — that must keep working.
  if (autoApplyOnNewRepo !== undefined) {
    const current = await getTemplate(req.params.id);
    if (current && !!current.autoApplyOnNewRepo !== !!autoApplyOnNewRepo) {
      const denied = await denyAutoApplyChange(req.user!.login);
      if (denied) {
        res.status(403).json({ error: denied, code: "CONTROL_HUB_ADMIN_REQUIRED" });
        return;
      }
    }
  }

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

    // Act as the signed-in user, not as the App. GitHub then permits exactly
    // what it would permit had they done this on github.com — someone with read
    // access to a repo gets a 403 here, as they should. Auto-apply (webhooks.ts)
    // still uses the App token: there is no user behind a repo-created event.
    const octokit = createOctokit(req.user!.accessToken);

    // Exclusion lists can reference repos across the org, so resolving them
    // needs the App's view rather than the caller's.
    const exclusionOctokit = createOctokit(getSystemToken() || req.user!.accessToken);
    const excludedRepos = template.exclusionLists?.length
      ? await resolveExcludedReposFromIds(template.exclusionLists, exclusionOctokit)
      : new Set<string>();
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

    let denied = 0;
    for (const repo of nonExcludedRepos) {
      // Logged up front so applyTemplate's child entries have a parent, then
      // rewritten below with what actually happened.
      const repoEntry = await logActivity(
        "template.apply.repo" as any, actor, repo, template.name,
        `Applying template "${template.name}" to ${repo}…`,
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
        await updateActivityOutcome(repoEntry.id, {
          details: result.errors.length
            ? `Applied template "${template.name}" to ${repo} with ${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}`
            : `Applied template "${template.name}" to ${repo}`,
          failed: result.errors.length > 0,
          errorMessage: result.errors.length ? result.errors.join("; ") : undefined,
        });
      } catch (e) {
        const permission = isPermissionDenied(e);
        if (permission) denied++;
        const message = permission
          ? permissionMessage(actor, "change branch protection", repo)
          : (e as Error).message;
        merged.errors.push(`[${repo}] ${message}`);
        await updateActivityOutcome(repoEntry.id, {
          details: permission
            ? `Not permitted to apply template "${template.name}" to ${repo}`
            : `Failed to apply template "${template.name}" to ${repo}`,
          failed: true,
          errorMessage: message,
        });
      }
    }

    await updateActivityOutcome(parentId, {
      details: `Applied template "${template.name}" to ${nonExcludedRepos.length - denied} of ${nonExcludedRepos.length} repo${nonExcludedRepos.length !== 1 ? "s" : ""}`,
      failed: merged.errors.length > 0,
      errorMessage: merged.errors.length ? merged.errors.slice(0, 5).join("; ") : undefined,
    });

    // Every target refused: report it as an authorization failure rather than a
    // partial success, so the UI can say so plainly.
    if (denied > 0 && denied === nonExcludedRepos.length) {
      res.status(403).json({ ...merged, code: "GITHUB_PERMISSION_DENIED", error: merged.errors[0] });
      return;
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "templates") });
  }
});

export default router;
