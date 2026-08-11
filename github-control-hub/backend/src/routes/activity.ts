/* v2: undo-event restores original for overridden conflicts */
import { Router } from "express";
import type { Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import {
  getActivity,
  getActivityForRepo,
  getActivityCount,
  getActivityMerged,
  getActivityById,
  getChildActivities,
  buildActivityTree,
  markActivityUndone,
  markActivityRedone,
  markActivityRetried,
  updateActivityError,
  updateActivityUndoPayload,
  updateActivityConflictResolution,
  clearConflictResolution,
  logActivity,
} from "../services/activityService";
import type { ActivityEntry } from "../services/activityService";
import { createOctokit, getOrg } from "../github/client";
import { assertWritable, RepoAccessDenied } from "../github/permissions";
import { undoBlockedReason, reposNeedingWrite, isReversible, ALLOWED_UNDO_ACTIONS } from "../services/undoPolicy";
import { permissionMessage } from "../utils/permissionError";
import {
  createBranch,
  deleteBranch,
  inspectBranchWork,
  branchWasTouched,
  deleteProtection,
  deleteRuleset,
  renameBranch,
  protectBranch,
  getProtection,
  buildRulesetRules,
  buildTagRulesetRules,
} from "../services/branchService";
import {
  putTemplateRaw,
  deleteTemplateRaw,
} from "../services/templateService";
import {
  putWidgetRaw,
  deleteWidgetRaw,
} from "../services/widgetService";
import {
  putScannerRaw,
  deleteScannerRaw,
} from "../services/scannerService";
import {
  putExclusionRaw,
  deleteExclusionRaw,
} from "../services/exclusionService";

const router = Router();

function collectNestedSignatures(entries: ActivityEntry[]): Set<string> {
  const sigs = new Set<string>();
  for (const e of entries) {
    if (e.children) {
      for (const child of e.children) addSignatures(child, sigs);
    }
  }
  return sigs;
}

function addSignatures(entry: ActivityEntry, sigs: Set<string>) {
  sigs.add(`${entry.repo}|${entry.target}|${Math.floor(new Date(entry.timestamp).getTime() / 60000)}`);
  sigs.add(`${entry.repo}|${entry.target}|${Math.floor(new Date(entry.timestamp).getTime() / 60000) - 1}`);
  sigs.add(`${entry.repo}|${entry.target}|${Math.floor(new Date(entry.timestamp).getTime() / 60000) + 1}`);
  if (entry.children) {
    for (const child of entry.children) addSignatures(child, sigs);
  }
}

router.get("/", async (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;
  const repo = req.query.repo as string | undefined;

  const allEntries = repo
    ? await getActivityForRepo(repo, limit + 200)
    : await getActivityMerged(limit + 200, 0);

  const topLevel = allEntries.filter(e => !e.parentId);
  const paginated = topLevel.slice(offset, offset + limit);

  const neededIds = new Set<string>(paginated.map(e => e.id));
  let prevSize = 0;
  while (neededIds.size !== prevSize) {
    prevSize = neededIds.size;
    for (const e of allEntries) {
      if (e.parentId && neededIds.has(e.parentId)) {
        neededIds.add(e.id);
      }
    }
  }

  const relevant = allEntries.filter(e => neededIds.has(e.id));
  let tree = buildActivityTree(relevant);

  const nestedSigs = collectNestedSignatures(tree);
  tree = tree.filter(entry => {
    if (entry.source !== "github") return true;
    const sig = `${entry.repo}|${entry.target}|${Math.floor(new Date(entry.timestamp).getTime() / 60000)}`;
    return !nestedSigs.has(sig);
  });

  const filteredTopLevel = topLevel.filter(entry => {
    if (entry.source !== "github") return true;
    const sig = `${entry.repo}|${entry.target}|${Math.floor(new Date(entry.timestamp).getTime() / 60000)}`;
    return !nestedSigs.has(sig);
  });

  res.json({
    entries: tree,
    total: filteredTopLevel.length,
    limit,
    offset,
  });
});

router.post("/:id/undo", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = await getActivityById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Activity entry not found" });
      return;
    }
    if (entry.undone) {
      res.status(400).json({ error: "This action has already been undone" });
      return;
    }

    const undone: string[] = [];
    const errors: string[] = [];

    // Gather the whole tree first. An undo of a template application touches
    // many repositories, and finding out halfway through that the caller
    // cannot write to the fourth one leaves three repositories changed and
    // nothing to point at explaining why the rest were not.
    const children = (await getChildActivities(entry.id)).filter(c => !c.undone);
    const descendants: ActivityEntry[] = [];
    for (const child of children) {
      descendants.push(...(await getChildActivities(child.id)).filter(gc => !gc.undone));
      descendants.push(child);
    }

    const blocked = undoBlockedReason(entry, descendants);
    if (blocked) {
      res.status(400).json({ error: blocked, code: "NOT_UNDOABLE" });
      return;
    }

    try {
      await assertWritable(
        createOctokit(req.user!.accessToken), getOrg(),
        reposNeedingWrite([...descendants, entry]),
      );
    } catch (err) {
      if (err instanceof RepoAccessDenied) {
        res.status(403).json({
          error: permissionMessage(req.user!.login, "undo this change", err.repos.join(", ")),
          code: "GITHUB_PERMISSION_DENIED",
          repos: err.repos,
        });
        return;
      }
      throw err;
    }

    for (const target of descendants) {
      try {
        await executeUndo(target, req.user!.accessToken);
        await markActivityUndone(target.id);
        undone.push(target.id);
      } catch (err) {
        errors.push(`Failed to undo ${target.action} on ${target.target}: ${(err as Error).message}`);
      }
    }

    // A parent stands for its children. If any of them was refused — a branch
    // holding commits, most likely — the group was not undone, and saying it
    // was would hide exactly the thing the user needs to see.
    if (errors.length > 0) {
      res.status(502).json({ error: errors[0], undone, errors });
      return;
    }

    // Only claim the entry is undone if it is. Marking it regardless is how the
    // log came to disagree with the account.
    if (entry.undoPayload) {
      try {
        await executeUndo(entry, req.user!.accessToken);
      } catch (err) {
        errors.push(`Failed to undo ${entry.action} on ${entry.target}: ${(err as Error).message}`);
        res.status(502).json({ error: errors[0], undone, errors });
        return;
      }
    }

    await markActivityUndone(entry.id);
    undone.push(entry.id);

    await logActivity(
      "activity.undo",
      req.user!.login,
      entry.repo,
      entry.target,
      `Undone: "${entry.details || entry.action}"${errors.length > 0 ? ` (${errors.length} error${errors.length !== 1 ? "s" : ""})` : ""}`,
      undefined, "app", undefined, undefined,
      { linkedActivityId: entry.id }
    );

    res.json({ undone, errors });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "activity") });
  }
});

router.post("/:id/redo", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = await getActivityById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Activity entry not found" });
      return;
    }
    if (!entry.undone) {
      res.status(400).json({ error: "This action has not been undone" });
      return;
    }

    const redone: string[] = [];
    const errors: string[] = [];
    const accessToken = req.user!.accessToken;

    // Same shape as undo, in reverse: whole tree gathered and access checked
    // before anything is written.
    const children = (await getChildActivities(entry.id)).filter(c => c.undone).reverse();
    const descendants: ActivityEntry[] = [];
    for (const child of children) {
      descendants.push(...(await getChildActivities(child.id)).filter(gc => gc.undone).reverse());
      descendants.push(child);
    }

    if (!isReversible(entry) && !descendants.some(isReversible)) {
      res.status(400).json({ error: "This action cannot be redone.", code: "NOT_UNDOABLE" });
      return;
    }

    try {
      await assertWritable(
        createOctokit(accessToken), getOrg(),
        reposNeedingWrite([...descendants, entry]),
      );
    } catch (err) {
      if (err instanceof RepoAccessDenied) {
        res.status(403).json({
          error: permissionMessage(req.user!.login, "redo this change", err.repos.join(", ")),
          code: "GITHUB_PERMISSION_DENIED",
          repos: err.repos,
        });
        return;
      }
      throw err;
    }

    for (const target of descendants) {
      if (!target.undoPayload) {
        // Rows the old undo path flagged without touching anything. Clearing
        // the flag is the repair, not a redo — there is nothing to reapply.
        await markActivityRedone(target.id);
        redone.push(target.id);
        continue;
      }
      try {
        await executeRedo(target, accessToken);
        await markActivityRedone(target.id);
        redone.push(target.id);
      } catch (err) {
        errors.push(`Failed to redo ${target.action} on ${target.target}: ${(err as Error).message}`);
      }
    }

    if (entry.undoPayload) {
      try {
        await executeRedo(entry, accessToken);
      } catch (err) {
        errors.push(`Failed to redo ${entry.action} on ${entry.target}: ${(err as Error).message}`);
        res.status(502).json({ error: errors[0], redone, errors });
        return;
      }
    }
    await markActivityRedone(entry.id);
    redone.push(entry.id);

    await logActivity(
      "activity.redo",
      req.user!.login,
      entry.repo,
      entry.target,
      `Redone: "${entry.details || entry.action}"${errors.length > 0 ? ` (${errors.length} error${errors.length !== 1 ? "s" : ""})` : ""}`,
      undefined, "app", undefined, undefined,
      { linkedActivityId: entry.id }
    );

    res.json({ redone, errors });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "activity") });
  }
});

router.post("/:id/retry", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = await getActivityById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Activity entry not found" });
      return;
    }

    const accessToken = req.user!.accessToken;
    const retried: string[] = [];
    const errors: string[] = [];

    if (entry.failed && entry.retryPayload) {
      try {
        const undoPayload = await executeRetry(entry, accessToken);
        await markActivityRetried(entry.id, undoPayload);
        retried.push(entry.id);
      } catch (err) {
        const msg = (err as Error).message;
        await updateActivityError(entry.id, msg);
        errors.push(`Failed to retry ${entry.action} on ${entry.target}: ${msg}`);
      }
    } else if (entry.children || (await getChildActivities(entry.id)).length > 0) {
      const children = await getChildActivities(entry.id);
      children.reverse();

      for (const child of children) {
        const grandchildren = await getChildActivities(child.id);
        grandchildren.reverse();

        for (const gc of grandchildren) {
          if (!gc.failed || !gc.retryPayload) continue;
          try {
            const undoPayload = await executeRetry(gc, accessToken);
            await markActivityRetried(gc.id, undoPayload);
            retried.push(gc.id);
          } catch (err) {
            const msg = (err as Error).message;
            await updateActivityError(gc.id, msg);
            errors.push(`Failed to retry ${gc.action} on ${gc.target}: ${msg}`);
          }
        }

        if (child.failed && child.retryPayload) {
          try {
            const undoPayload = await executeRetry(child, accessToken);
            await markActivityRetried(child.id, undoPayload);
            retried.push(child.id);
          } catch (err) {
            const msg = (err as Error).message;
            await updateActivityError(child.id, msg);
            errors.push(`Failed to retry ${child.action} on ${child.target}: ${msg}`);
          }
        }
      }
    }

    if (retried.length > 0) {
      await logActivity(
        "activity.retry",
        req.user!.login,
        entry.repo,
        entry.target,
        `Retried: "${entry.details || entry.action}"${errors.length > 0 ? ` (${errors.length} error${errors.length !== 1 ? "s" : ""})` : ""}`
      );
    }

    res.json({ retried, errors });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "activity") });
  }
});

router.post("/:id/resolve-conflict", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { resolution } = req.body;
    if (resolution !== "override" && resolution !== "skip") {
      res.status(400).json({ error: "resolution must be 'override' or 'skip'" });
      return;
    }

    const entry = await getActivityById(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Activity entry not found" });
      return;
    }
    if (!entry.conflictPayload) {
      res.status(400).json({ error: "This entry has no conflict to resolve" });
      return;
    }
    if (entry.conflictResolution) {
      res.status(400).json({ error: `This conflict has already been resolved as "${entry.conflictResolution}"` });
      return;
    }

    const cp = entry.conflictPayload;
    const octokit = createOctokit(req.user!.accessToken);
    const org = getOrg();
    const actor = req.user!.login;

    if (resolution === "override") {
      if (cp.type === "ruleset") {
        const isTagRuleset = !!cp.templateConfig?._isTagRuleset;

        let originalConfig: any;
        let currentExistingId: number | undefined;
        try {
          const rulesets = await octokit.rest.repos.getRepoRulesets({ owner: org, repo: cp.repo, per_page: 100, includes_parents: false });
          const list = Array.isArray(rulesets.data) ? rulesets.data : [];
          const match = list.find((r: any) => r.name === cp.name);
          if (match) currentExistingId = match.id;
        } catch { /* best effort - fall back to stored ID */ }
        if (!currentExistingId && cp.existingId) currentExistingId = cp.existingId;

        if (currentExistingId) {
          try {
            const { data: full } = await octokit.rest.repos.getRepoRuleset({ owner: org, repo: cp.repo, ruleset_id: currentExistingId });
            originalConfig = full;
          } catch { /* best effort */ }
          try { await deleteRuleset(octokit, cp.repo, currentExistingId); } catch { /* may already be gone */ }
        }

        const protection = cp.templateConfig;
        let createdId: number | undefined;

        if (isTagRuleset) {
          const tagPatterns: string[] = protection.tagPatterns || cp.existingConfig?.conditions?.ref_name?.include?.map((ref: string) => ref.replace("refs/tags/", "")) || [];

          if (protection.rawJson) {
            const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, created_at: _ca, updated_at: _ua, ...payload } = protection.rawJson;
            if (payload.bypass_actors) {
              payload.bypass_actors = payload.bypass_actors.map((a: any) => ({ ...a, bypass_mode: "always" }));
            }
            const { data: created } = await octokit.rest.repos.createRepoRuleset({
              owner: org, repo: cp.repo, ...payload,
              name: cp.name,
              target: "tag",
              conditions: { ref_name: { include: tagPatterns.map((t: string) => `refs/tags/${t}`), exclude: [] } },
            });
            createdId = created.id;
          } else {
            const rules: any[] = buildTagRulesetRules(protection);
            if (rules.length === 0) rules.push({ type: "creation" });
            const bypassActors = (protection.bypassActors && protection.bypassActors.length > 0)
              ? protection.bypassActors.map((a: any) => ({ ...a, bypass_mode: "always" }))
              : [];
            const { data: created } = await octokit.rest.repos.createRepoRuleset({
              owner: org, repo: cp.repo,
              name: cp.name,
              target: "tag",
              enforcement: (protection.enforcement as any) || "active",
              bypass_actors: bypassActors,
              conditions: { ref_name: { include: tagPatterns.map((t: string) => `refs/tags/${t}`), exclude: [] } },
              rules,
            });
            createdId = created.id;
          }

          const undoPayload = {
            action: "undo_override_ruleset",
            params: { repo: cp.repo, newRulesetId: createdId, originalConfig: originalConfig || cp.existingConfig, templateConfig: cp.templateConfig, tagPatterns, isTagRuleset: true },
          };
          await updateActivityConflictResolution(entry.id, "override");
          await updateActivityUndoPayload(entry.id, undoPayload);
        } else {
          const branchNames: string[] = cp.existingConfig?.conditions?.ref_name?.include?.map((ref: string) => ref.replace("refs/heads/", "")) || [cp.name];

          if (protection.type === "ruleset_json" && protection.rawJson) {
            const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, ...payload } = protection.rawJson;
            const { data: created } = await octokit.rest.repos.createRepoRuleset({
              owner: org, repo: cp.repo, ...payload,
              name: cp.name,
              conditions: { ref_name: { include: branchNames.map((b: string) => `refs/heads/${b}`), exclude: [] } },
            });
            createdId = created.id;
          } else {
            const rules: any[] = buildRulesetRules(protection);
            if (rules.length === 0) rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0 } });
            let bypassActors: any[];
            if (protection.bypassActors && protection.bypassActors.length > 0) {
              bypassActors = protection.bypassActors;
            } else if (protection.enforceAdmins) {
              bypassActors = [];
            } else {
              bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
            }
            const { data: created } = await octokit.rest.repos.createRepoRuleset({
              owner: org, repo: cp.repo,
              name: cp.name,
              target: "branch",
              enforcement: (protection.enforcement as any) || "active",
              bypass_actors: bypassActors,
              conditions: { ref_name: { include: branchNames.map((b: string) => `refs/heads/${b}`), exclude: [] } },
              rules,
            });
            createdId = created.id;
          }

          const undoPayload = {
            action: "undo_override_ruleset",
            params: { repo: cp.repo, newRulesetId: createdId, originalConfig: originalConfig || cp.existingConfig, templateConfig: cp.templateConfig, branchNames },
          };
          await updateActivityConflictResolution(entry.id, "override");
          await updateActivityUndoPayload(entry.id, undoPayload);
        }
        await logActivity(
          "conflict.override" as any, actor, cp.repo, cp.name,
          `Overrode existing ${isTagRuleset ? "tag " : ""}ruleset "${cp.name}" with template configuration`,
          undefined, "app", undefined, undefined,
          { linkedActivityId: entry.id }
        );
      } else {
        const protection = cp.templateConfig;

        let originalConfig: any;
        try {
          originalConfig = await getProtection(octokit, cp.repo, cp.name);
        } catch { /* best effort */ }

        const classicRestrictions = protection.restrictPushes
          ? { users: protection.pushRestrictionUsers || [], teams: protection.pushRestrictionTeams || [], apps: protection.pushRestrictionApps || [] }
          : { users: [] as string[], teams: [] as string[], apps: [] as string[] };

        await octokit.rest.repos.updateBranchProtection({
          owner: org, repo: cp.repo, branch: cp.name,
          required_status_checks: protection.requireStatusChecks ? { strict: protection.strictStatusChecks, contexts: [] } : null,
          enforce_admins: protection.enforceAdmins,
          required_pull_request_reviews: protection.requirePr
            ? { required_approving_review_count: protection.requiredApprovals, dismiss_stale_reviews: protection.dismissStaleReviews, require_code_owner_reviews: protection.requireCodeOwnerReviews, dismissal_restrictions: {} }
            : null,
          restrictions: classicRestrictions,
          required_linear_history: protection.requireLinearHistory,
          allow_force_pushes: !protection.preventForcePush,
          allow_deletions: !protection.preventDeletion,
          required_conversation_resolution: protection.requireConversationResolution,
          required_signatures: protection.requireSignedCommits,
        });

        const undoPayload = {
          action: "undo_override_protection",
          params: { repo: cp.repo, branch: cp.name, originalConfig: originalConfig || cp.existingConfig, templateConfig: cp.templateConfig },
        };
        await updateActivityConflictResolution(entry.id, "override");
        await updateActivityUndoPayload(entry.id, undoPayload);
        await logActivity(
          "conflict.override" as any, actor, cp.repo, cp.name,
          `Overrode existing classic protection on "${cp.name}" with template configuration`,
          undefined, "app", undefined, undefined,
          { linkedActivityId: entry.id }
        );
      }
    } else {
      await updateActivityConflictResolution(entry.id, "skip");
      await logActivity(
        "conflict.skip" as any, actor, cp.repo, cp.name,
        `Skipped conflict for ${cp.type === "ruleset" ? (cp.templateConfig?._isTagRuleset ? "tag ruleset" : "ruleset") : "classic protection"} "${cp.name}"`,
        undefined, "app", undefined, undefined,
        { linkedActivityId: entry.id }
      );
    }

    res.json({ resolved: true, resolution });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "activity") });
  }
});

router.post("/:id/undo-resolution", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const entry = await getActivityById(req.params.id);
    if (!entry) { res.status(404).json({ error: "Activity entry not found" }); return; }
    if (!entry.conflictResolution) { res.status(400).json({ error: "This entry has no resolution to undo" }); return; }

    const actor = req.user!.login;

    if (entry.conflictResolution === "override" && entry.undoPayload) {
      await executeUndo(entry, req.user!.accessToken);
    }

    await clearConflictResolution(entry.id);

    await logActivity(
      "activity.undo" as any, actor, entry.repo, entry.target,
      `Undone: ${entry.conflictResolution === "override" ? "Override" : "Skip"} resolution for "${entry.target}"`,
      undefined, "app", undefined, undefined,
      { linkedActivityId: entry.id }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "activity") });
  }
});

async function executeRetry(entry: ActivityEntry, accessToken: string): Promise<import("../services/activityService").UndoPayload | undefined> {
  if (!entry.retryPayload) return undefined;
  const { action, params } = entry.retryPayload;
  const octokit = createOctokit(accessToken);
  const org = getOrg();

  switch (action) {
    case "create_branch":
      await createBranch(octokit, params.repo, params.branch, params.baseBranch || "main");
      return { action: "delete_branch", params: { repo: params.repo, branch: params.branch, baseBranch: params.baseBranch } };

    case "apply_protection":
      await protectBranch(octokit, params.repo, params.branch, params.protectionConfig);
      return { action: "delete_protection", params: { repo: params.repo, branch: params.branch, protectionConfig: params.protectionConfig } };

    case "create_ruleset": {
      const protection = params.protectionConfig;
      const branchNames: string[] = params.branchNames || [entry.target];
      let createdRulesetId: number | undefined;

      if (protection.type === "ruleset_json" && protection.rawJson) {
        const { id, source, source_type, node_id, _links, ...payload } = protection.rawJson;
        const { data: created } = await octokit.rest.repos.createRepoRuleset({
          owner: org, repo: params.repo, ...payload,
          name: protection.rulesetName || payload.name || entry.target,
          conditions: { ref_name: { include: branchNames.map((b: string) => `refs/heads/${b}`), exclude: [] } },
        });
        createdRulesetId = created.id;
      } else {
        const rules: any[] = buildRulesetRules(protection);
        if (rules.length === 0) rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0 } });
        let bypassActors: any[];
        if (protection.bypassActors && protection.bypassActors.length > 0) {
          bypassActors = protection.bypassActors;
        } else if (protection.enforceAdmins) {
          bypassActors = [];
        } else {
          bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const }];
        }
        const { data: created } = await octokit.rest.repos.createRepoRuleset({
          owner: org, repo: params.repo,
          name: protection.rulesetName || `Ruleset (${branchNames.join(", ")})`,
          target: "branch", enforcement: (protection.enforcement as any) || "active",
          bypass_actors: bypassActors,
          conditions: { ref_name: { include: branchNames.map((b: string) => `refs/heads/${b}`), exclude: [] } },
          rules,
        });
        createdRulesetId = created.id;
      }
      return { action: "delete_ruleset", params: { repo: params.repo, rulesetId: createdRulesetId, protectionConfig: params.protectionConfig, branchNames: params.branchNames } };
    }

    case "rename_branch":
      await renameBranch(octokit, params.repo, params.from, params.to);
      return { action: "rename_branch", params: { repo: params.repo, from: params.to, to: params.from } };

    case "create_tag_ruleset": {
      const tagRule = params.tagRule;
      const tagPatterns: string[] = params.tagPatterns || tagRule?.tagPatterns || [];
      if (!tagRule || tagPatterns.length === 0) return undefined;

      const rulesetName = tagRule.rulesetName || `Tag Ruleset (${tagPatterns.join(", ")})`;
      const rules = buildTagRulesetRules(tagRule);
      if (rules.length === 0) rules.push({ type: "creation" });

      const bypassActors = (tagRule.bypassActors && tagRule.bypassActors.length > 0)
        ? tagRule.bypassActors.map((a: any) => ({ ...a, bypass_mode: "always" }))
        : [];

      const { data: created } = await octokit.rest.repos.createRepoRuleset({
        owner: org,
        repo: params.repo,
        name: rulesetName,
        target: "tag",
        enforcement: (tagRule.enforcement as any) || "active",
        bypass_actors: bypassActors,
        conditions: {
          ref_name: { include: tagPatterns.map((t: string) => `refs/tags/${t}`), exclude: [] },
        },
        rules,
      });
      return { action: "delete_ruleset", params: { repo: params.repo, rulesetId: created.id, tagRule, tagPatterns } };
    }

    default:
      return undefined;
  }
}

async function executeUndo(entry: ActivityEntry, accessToken: string): Promise<void> {
  if (!entry.undoPayload) return;
  const { action, params } = entry.undoPayload;
  const octokit = createOctokit(accessToken);
  const org = getOrg();

  if (!ALLOWED_UNDO_ACTIONS.has(action)) {
    throw new Error(`"${action}" is not something the Control Hub can reverse`);
  }

  switch (action) {
    case "delete_branch": {
      // Undoing a branch creation deletes the branch, which is fine while it is
      // still the empty pointer the template made. Once someone has committed
      // to it, this is the one undo path that can destroy work, and GitHub
      // offers no way back. Refuse and let a human decide.
      const work = await inspectBranchWork(octokit, params.repo, params.branch, {
        createdFromSha: params.createdFromSha,
        baseBranch: params.baseBranch,
        createdAt: entry.timestamp,
      });

      if (work && branchWasTouched(work)) {
        // Named precisely where we can be: unmerged commits are the case where
        // deleting definitely destroys work. Otherwise the branch moved — a
        // merge, a squash, a rebase, a force-push — and we say so rather than
        // guessing which.
        const detail = work.unmergedCommits > 0
          ? `${work.unmergedCommits} commit${work.unmergedCommits === 1 ? "" : "s"} that ${work.unmergedCommits === 1 ? "is" : "are"} not in "${params.baseBranch}"`
          : "commits, merges or rewritten history";
        throw new Error(
          `"${params.branch}" in ${params.repo} has ${detail} beyond the point of creation. ` +
          `Undoing would delete the branch and discard that work, so it was left alone. ` +
          `Merge or move the work first, then delete the branch in GitHub.`
        );
      }

      if (work) params.latestSha = work.tip;
      await deleteBranch(octokit, params.repo, params.branch);
      if (params.latestSha) {
        await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      }
      break;
    }
    case "delete_protection": {
      try {
        const currentConfig = await getProtection(octokit, params.repo, params.branch);
        if (currentConfig) params.protectionConfig = currentConfig;
      } catch { /* protection may already be gone */ }
      await deleteProtection(octokit, params.repo, params.branch);
      await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      break;
    }
    case "delete_ruleset": {
      let rulesetId = params.rulesetId ? parseInt(params.rulesetId, 10) : undefined;

      if (!rulesetId) {
        try {
          const rulesets = await octokit.rest.repos.getRepoRulesets({ owner: org, repo: params.repo });
          const rulesetName = params.protectionConfig?.rulesetName || entry.target;
          const match = (rulesets.data as any[]).find((r: any) => r.name === rulesetName);
          if (match) rulesetId = match.id;
        } catch { /* best effort lookup */ }
      }

      if (rulesetId) {
        try {
          const { data: currentRuleset } = await octokit.rest.repos.getRepoRuleset({ owner: org, repo: params.repo, ruleset_id: rulesetId });
          params.latestRulesetConfig = currentRuleset;
        } catch { /* ruleset may already be gone */ }
        await deleteRuleset(octokit, params.repo, rulesetId);
        params.rulesetId = rulesetId;
        await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      }
      break;
    }
    case "undo_override_ruleset": {
      let deleteId = params.newRulesetId ? parseInt(params.newRulesetId, 10) : undefined;
      if (deleteId) {
        try {
          const { data: currentNew } = await octokit.rest.repos.getRepoRuleset({ owner: org, repo: params.repo, ruleset_id: deleteId });
          params.latestNewConfig = currentNew;
        } catch {
          deleteId = undefined;
        }
      }
      if (!deleteId) {
        try {
          const rulesets = await octokit.rest.repos.getRepoRulesets({ owner: org, repo: params.repo });
          const match = (rulesets.data as any[]).find((r: any) => r.name === entry.target);
          if (match) deleteId = match.id;
        } catch { /* best effort */ }
      }
      if (deleteId) {
        try { await deleteRuleset(octokit, params.repo, deleteId); } catch { /* may already be gone */ }
      }
      if (params.originalConfig) {
        const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, created_at: _ca, updated_at: _ua, ...payload } = params.originalConfig;
        const { data: restored } = await octokit.rest.repos.createRepoRuleset({ owner: org, repo: params.repo, ...payload });
        params.restoredOriginalId = restored.id;
      }
      await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      break;
    }
    case "undo_override_protection": {
      if (params.originalConfig) {
        await protectBranch(octokit, params.repo, params.branch, params.originalConfig);
      }
      break;
    }
    case "rename_branch":
      await renameBranch(octokit, params.repo, params.from, params.to);
      break;
    case "recreate_branch":
      if (params.sha) {
        await octokit.rest.git.createRef({ owner: org, repo: params.repo, ref: `refs/heads/${params.branch}`, sha: params.sha });
      } else {
        await createBranch(octokit, params.repo, params.branch, "main");
      }
      break;
    case "restore_protection":
      if (params.protectionConfig) {
        await protectBranch(octokit, params.repo, params.branch, params.protectionConfig);
      }
      break;
    case "recreate_ruleset":
      if (params.rulesetConfig) {
        const { id, source, source_type, node_id, _links, ...payload } = params.rulesetConfig;
        await octokit.rest.repos.createRepoRuleset({ owner: org, repo: params.repo, ...payload });
      }
      break;
    case "revert_template":
      if (params.previousState && params.templateId) {
        await putTemplateRaw({ ...params.previousState, updatedAt: new Date().toISOString() });
      }
      break;
    case "restore_template":
      if (params.templateData) {
        await putTemplateRaw(params.templateData);
      }
      break;
    case "delete_template":
      if (params.templateId) {
        await deleteTemplateRaw(params.templateId);
      }
      break;
    case "delete_widget":
      if (params.widgetId) {
        await deleteWidgetRaw(params.widgetId);
      }
      break;
    case "restore_widget":
      if (params.widgetData) {
        await putWidgetRaw(params.widgetData);
      }
      break;
    case "revert_widget":
      if (params.previousState && params.widgetId) {
        await putWidgetRaw({ ...params.previousState, updatedAt: new Date().toISOString() });
      }
      break;
    case "delete_scanner":
      if (params.scannerId) {
        await deleteScannerRaw(params.scannerId);
      }
      break;
    case "restore_scanner":
      if (params.scannerData) {
        await putScannerRaw(params.scannerData);
      }
      break;
    case "revert_scanner":
      if (params.previousState && params.scannerId) {
        await putScannerRaw({ ...params.previousState, updatedAt: new Date().toISOString() });
      }
      break;
    case "delete_exclusion":
      if (params.exclusionId) {
        await deleteExclusionRaw(params.exclusionId);
      }
      break;
    case "restore_exclusion":
      if (params.exclusionData) {
        await putExclusionRaw(params.exclusionData);
      }
      break;
    case "revert_exclusion":
      if (params.previousState && params.exclusionId) {
        await putExclusionRaw({ ...params.previousState, updatedAt: new Date().toISOString() });
      }
      break;
    case "disable_dependabot": {
      const depOctokit = createOctokit(accessToken);
      await depOctokit.rest.repos.disableVulnerabilityAlerts({ owner: org, repo: params.repo });
      break;
    }
    case "enable_dependabot": {
      const depOctokit = createOctokit(accessToken);
      await depOctokit.rest.repos.enableVulnerabilityAlerts({ owner: org, repo: params.repo });
      break;
    }
    default:
      // ALLOWED_UNDO_ACTIONS is checked above, so reaching here means the two
      // lists have drifted apart.
      throw new Error(`No handler for "${action}"`);
  }
}

async function executeRedo(entry: ActivityEntry, accessToken: string): Promise<void> {
  if (!entry.undoPayload) return;
  const { action, params } = entry.undoPayload;
  const octokit = createOctokit(accessToken);
  const org = getOrg();

  if (!ALLOWED_UNDO_ACTIONS.has(action)) {
    throw new Error(`"${action}" is not something the Control Hub can reverse`);
  }

  switch (action) {
    case "delete_branch":
      if (params.latestSha) {
        await octokit.rest.git.createRef({ owner: org, repo: params.repo, ref: `refs/heads/${params.branch}`, sha: params.latestSha });
      } else {
        await createBranch(octokit, params.repo, params.branch, params.baseBranch || "main");
      }
      break;

    case "delete_protection":
      if (params.protectionConfig) {
        await protectBranch(octokit, params.repo, params.branch, params.protectionConfig);
      }
      break;

    case "delete_ruleset": {
      let newRulesetId: number | undefined;
      if (params.latestRulesetConfig) {
        const { id: _id, source: _s, source_type: _st, node_id: _n, _links: _l, created_at: _ca, updated_at: _ua, ...payload } = params.latestRulesetConfig;
        const { data: created } = await octokit.rest.repos.createRepoRuleset({ owner: org, repo: params.repo, ...payload });
        newRulesetId = created.id;
      } else if (params.protectionConfig) {
        const protection = params.protectionConfig;
        const branchNames: string[] = params.branchNames || [entry.target];

        if (protection.type === "ruleset_json" && protection.rawJson) {
          const { id, source, source_type, node_id, _links, ...payload } = protection.rawJson;
          const { data: created } = await octokit.rest.repos.createRepoRuleset({
            owner: org,
            repo: params.repo,
            ...payload,
            name: protection.rulesetName || payload.name || entry.target,
            conditions: {
              ref_name: {
                include: branchNames.map((b: string) => `refs/heads/${b}`),
                exclude: [],
              },
            },
          });
          newRulesetId = created.id;
        } else {
          const rules: any[] = buildRulesetRules(protection);
          if (rules.length === 0) {
            rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0 } });
          }
          let bypassActors: any[];
          if (protection.bypassActors && protection.bypassActors.length > 0) {
            bypassActors = protection.bypassActors;
          } else if (protection.enforceAdmins) {
            bypassActors = [];
          } else {
            bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const }];
          }
          const { data: created } = await octokit.rest.repos.createRepoRuleset({
            owner: org,
            repo: params.repo,
            name: protection.rulesetName || `Template Ruleset (${branchNames.join(", ")})`,
            target: "branch",
            enforcement: (protection.enforcement as any) || "active",
            bypass_actors: bypassActors,
            conditions: {
              ref_name: {
                include: branchNames.map((b: string) => `refs/heads/${b}`),
                exclude: [],
              },
            },
            rules,
          });
          newRulesetId = created.id;
        }
      }
      if (newRulesetId) {
        params.rulesetId = newRulesetId;
        await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      }
      break;
    }

    case "undo_override_ruleset": {
      if (params.restoredOriginalId) {
        try { await deleteRuleset(octokit, params.repo, parseInt(params.restoredOriginalId, 10)); } catch { /* may already be gone */ }
      }
      const protection = params.templateConfig;
      const branchNames: string[] = params.branchNames || [entry.target];
      const rules: any[] = buildRulesetRules(protection);
      if (rules.length === 0) rules.push({ type: "pull_request", parameters: { required_approving_review_count: 0 } });
      let bypassActors: any[];
      if (protection.bypassActors && protection.bypassActors.length > 0) {
        bypassActors = protection.bypassActors;
      } else if (protection.enforceAdmins) {
        bypassActors = [];
      } else {
        bypassActors = [{ actor_id: 5, actor_type: "RepositoryRole" as const, bypass_mode: "always" as const }];
      }
      const { data: redoneRuleset } = await octokit.rest.repos.createRepoRuleset({
        owner: org, repo: params.repo,
        name: entry.target,
        target: "branch",
        enforcement: (protection.enforcement as any) || "active",
        bypass_actors: bypassActors,
        conditions: { ref_name: { include: branchNames.map((b: string) => `refs/heads/${b}`), exclude: [] } },
        rules,
      });
      params.newRulesetId = redoneRuleset.id;
      delete params.restoredOriginalId;
      await updateActivityUndoPayload(entry.id, { action, params: { ...params } });
      break;
    }
    case "undo_override_protection": {
      if (params.templateConfig) {
        const tp = params.templateConfig;
        const classicRestrictions = tp.restrictPushes
          ? { users: tp.pushRestrictionUsers || [], teams: tp.pushRestrictionTeams || [], apps: tp.pushRestrictionApps || [] }
          : { users: [] as string[], teams: [] as string[], apps: [] as string[] };
        await octokit.rest.repos.updateBranchProtection({
          owner: org, repo: params.repo, branch: params.branch,
          required_status_checks: tp.requireStatusChecks ? { strict: tp.strictStatusChecks, contexts: [] } : null,
          enforce_admins: tp.enforceAdmins,
          required_pull_request_reviews: tp.requirePr
            ? { required_approving_review_count: tp.requiredApprovals, dismiss_stale_reviews: tp.dismissStaleReviews, require_code_owner_reviews: tp.requireCodeOwnerReviews, dismissal_restrictions: {} }
            : null,
          restrictions: classicRestrictions,
          required_linear_history: tp.requireLinearHistory,
          allow_force_pushes: !tp.preventForcePush,
          allow_deletions: !tp.preventDeletion,
          required_conversation_resolution: tp.requireConversationResolution,
          required_signatures: tp.requireSignedCommits,
        });
      }
      break;
    }

    case "rename_branch":
      await renameBranch(octokit, params.repo, params.to, params.from);
      break;

    case "recreate_branch":
      await deleteBranch(octokit, params.repo, params.branch);
      break;

    case "restore_protection":
      await deleteProtection(octokit, params.repo, params.branch);
      break;

    case "recreate_ruleset":
      if (params.rulesetConfig) {
        const rulesets = await octokit.rest.repos.getRepoRulesets({ owner: org, repo: params.repo });
        const match = (rulesets.data as any[]).find((r: any) => r.name === params.rulesetConfig.name);
        if (match) {
          await deleteRuleset(octokit, params.repo, match.id);
        }
      }
      break;

    case "revert_template":
      if (params.currentState && params.templateId) {
        await putTemplateRaw({ ...params.currentState, updatedAt: new Date().toISOString() });
      }
      break;

    case "restore_template":
      if (params.templateData) {
        await deleteTemplateRaw(params.templateData.id);
      }
      break;

    case "delete_template":
      if (params.templateData) {
        await putTemplateRaw(params.templateData);
      }
      break;

    case "delete_widget":
      if (params.widgetData) {
        await putWidgetRaw(params.widgetData);
      }
      break;

    case "restore_widget":
      if (params.widgetData) {
        await deleteWidgetRaw(params.widgetData.id);
      }
      break;

    case "revert_widget":
      if (params.currentState && params.widgetId) {
        await putWidgetRaw({ ...params.currentState, updatedAt: new Date().toISOString() });
      }
      break;

    case "delete_scanner":
      if (params.scannerData) {
        await putScannerRaw(params.scannerData);
      }
      break;

    case "restore_scanner":
      if (params.scannerData) {
        await deleteScannerRaw(params.scannerData.id);
      }
      break;

    case "revert_scanner":
      if (params.currentState && params.scannerId) {
        await putScannerRaw({ ...params.currentState, updatedAt: new Date().toISOString() });
      }
      break;

    case "delete_exclusion":
      if (params.exclusionData) {
        await putExclusionRaw(params.exclusionData);
      }
      break;

    case "restore_exclusion":
      if (params.exclusionData) {
        await deleteExclusionRaw(params.exclusionData.id);
      }
      break;

    case "revert_exclusion":
      if (params.currentState && params.exclusionId) {
        await putExclusionRaw({ ...params.currentState, updatedAt: new Date().toISOString() });
      }
      break;

    case "disable_dependabot": {
      const depOctokit = createOctokit(accessToken);
      await depOctokit.rest.repos.enableVulnerabilityAlerts({ owner: org, repo: params.repo });
      break;
    }

    case "enable_dependabot": {
      const depOctokit = createOctokit(accessToken);
      await depOctokit.rest.repos.disableVulnerabilityAlerts({ owner: org, repo: params.repo });
      break;
    }

    default:
      // ALLOWED_UNDO_ACTIONS is checked above, so reaching here means the two
      // lists have drifted apart.
      throw new Error(`No handler for "${action}"`);
  }
}

export default router;
