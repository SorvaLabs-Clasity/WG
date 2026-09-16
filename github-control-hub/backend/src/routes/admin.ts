import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { requirePermission } from "../middleware/permissionGate";
import {
  loadPermissions, savePermissions, isFailure, unknownNodesIn, fileProblems,
  forgetPermissions, accessForOther, PERMISSIONS,
} from "../permissions";
import { VOCABULARY_VERSION } from "../permissions/vocabulary";
import { emptyFile, type PermissionsFile } from "../permissions/types";
import { PERMISSIONS_REPO, PERMISSIONS_PATH } from "../permissions/store";
import { createOctokit, getSystemToken, getOrg } from "../github/client";

/**
 * The Admin tab: the one router that can grant permissions.
 *
 * Every route is gated per the table in the brief, and gated harder than the
 * rest of the app dares to be sloppy about — a hole here is a hole in
 * everything else, because this is the screen that decides what everything
 * else lets through.
 */

const router = Router();

router.get("/file", requirePermission("admin.people.read"), async (_req: Request, res: Response) => {
  try {
    const loaded = await loadPermissions();

    // A read failure is returned as 200, not an error. The Admin tab's whole
    // job is to fix a broken file, so it has to be able to see one when it
    // cannot be used — a 5xx here would hide the exact screen that repairs it.
    if (isFailure(loaded)) {
      res.json({ failure: loaded });
      return;
    }

    res.json({
      file: loaded.file,
      sha: loaded.sha,
      source: loaded.source,
      unknownNodes: unknownNodesIn(loaded.file),
      problems: fileProblems(loaded.file),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

router.put("/file", requirePermission("admin.people.assign"), async (req: Request, res: Response) => {
  const { file, sha, summary } = req.body ?? {};

  if (typeof summary !== "string" || summary.trim().length === 0 || summary.length >= 200) {
    res.status(400).json({ error: "summary must be a non-empty string under 200 characters" });
    return;
  }

  try {
    // sha is the blob the editor loaded; savePermissions refuses rather than
    // clobbering a concurrent edit if it has moved on.
    const result = await savePermissions(file as PermissionsFile, sha ?? null, req.user!.login, summary);

    if (result.ok) {
      res.json({ ok: true, sha: result.sha });
      return;
    }

    if (result.reason === "conflict") {
      res.status(409).json({ code: "conflict", error: result.detail });
      return;
    }

    if (result.reason === "invalid") {
      res.status(400).json({ error: result.detail, problems: fileProblems(file) });
      return;
    }

    res.status(502).json({ error: result.detail });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

// So the tree renders from the server's own list rather than a copy that can
// drift from it as the vocabulary grows.
router.get("/vocabulary", requirePermission("admin.console.open"), (_req: Request, res: Response) => {
  res.json({ permissions: PERMISSIONS, version: VOCABULARY_VERSION });
});

router.get("/person/:login", requirePermission("admin.people.read"), async (req: Request<{ login: string }>, res: Response) => {
    try {
      // accessForOther, never accessForSelf: this is an administrator asking
      // about somebody else, and accessForSelf would attribute the caller's
      // own teams to the login being inspected.
      const access = await accessForOther(req.params.login);

      const explanations: Record<string, ReturnType<typeof access.permissions.explain>> = {};
      for (const leaf of PERMISSIONS) {
        explanations[leaf.key] = access.permissions.explain(leaf.key);
      }

      res.json({ login: req.params.login, held: access.permissions.held, explanations });
    } catch (err) {
      res.status(500).json({ error: sanitizeError(err, "admin") });
    }
  });

router.get("/audit", requirePermission("admin.audit.read"), async (_req: Request, res: Response) => {
  try {
    const octokit = createOctokit(getSystemToken(), "Permissions");
    const { data } = await octokit.rest.repos.listCommits({
      owner: getOrg(),
      repo: PERMISSIONS_REPO,
      path: PERMISSIONS_PATH,
    });

    res.json(data.map(c => ({
      sha: c.sha,
      message: c.commit.message,
      author: c.commit.author?.name ?? c.author?.login ?? "unknown",
      date: c.commit.author?.date ?? null,
    })));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

router.post("/bootstrap", requirePermission("admin.people.assign"), async (req: Request, res: Response) => {
  const createRepo = req.body?.createRepo === true;

  try {
    let loaded = await loadPermissions();
    let repoCreated = false;

    if (!isFailure(loaded) && loaded.source === "no-repo") {
      if (!createRepo) {
        res.json({
          repoCreated: false,
          fileCreated: false,
          detail: `${PERMISSIONS_REPO} does not exist. Pass createRepo: true to create it.`,
        });
        return;
      }

      const octokit = createOctokit(getSystemToken(), "Permissions");
      await octokit.rest.repos.createInOrg({ org: getOrg(), name: PERMISSIONS_REPO, private: true });
      repoCreated = true;

      forgetPermissions();
      loaded = await loadPermissions();
    }

    if (isFailure(loaded)) {
      res.status(502).json({ repoCreated, fileCreated: false, failure: loaded });
      return;
    }

    let fileCreated = false;
    if (loaded.source === "absent" || loaded.source === "no-repo") {
      const result = await savePermissions(emptyFile(), null, req.user!.login, "Initialise permissions");
      if (!result.ok) {
        res.status(502).json({ repoCreated, fileCreated: false, error: result.detail });
        return;
      }
      fileCreated = true;
    }

    res.json({ repoCreated, fileCreated });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

export default router;
