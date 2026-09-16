import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { requirePermission, requireAnyPermission, PERMISSIONS_ENABLED } from "../middleware/permissionGate";
import {
  loadPermissions, savePermissions, isFailure, unknownNodesIn, fileProblems,
  forgetPermissions, accessForSelf, accessForOther, PERMISSIONS,
  changeClasses, explainPreset,
} from "../permissions";
import { VOCABULARY_VERSION } from "../permissions/vocabulary";
import { emptyFile, type PermissionsFile } from "../permissions/types";
import { PERMISSIONS_REPO, PERMISSIONS_PATH } from "../permissions/store";
import { startingFile, dryRun, type MemberSnapshot } from "../permissions/migrate";
import { createOctokit, getSystemToken, getOrg } from "../github/client";
import { listOrgMembers, depsFromOctokit } from "../services/orgMembersService";
import { CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } from "../services/authorizationService";

/**
 * The Admin tab: the one router that can grant permissions.
 *
 * Every route is gated per the table in the brief, and gated harder than the
 * rest of the app dares to be sloppy about — a hole here is a hole in
 * everything else, because this is the screen that decides what everything
 * else lets through.
 */

const router = Router();

// People and Presets both render from this one file, so either read
// permission has to be enough to load it — gating it on admin.people.read
// alone would 403 somebody who holds only admin.presets.read before they
// ever reach the Presets tab.
router.get("/file", requireAnyPermission("admin.people.read", "admin.presets.read"), async (_req: Request, res: Response) => {
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

/**
 * This receives a whole file, the same shape whether the caller only meant to
 * change one person's note or meant to rewrite every preset in the
 * organization. `requireAnyPermission` below is a cheap rejection of somebody
 * with no admin write authority at all — it is not the whole answer, because
 * every one of the five admin write permissions reaches this one route.
 *
 * `changeClasses` derives what the write actually does from the diff against
 * what is currently stored, and the handler requires every class it names —
 * never just the most specific one — the same rule `config.import` follows
 * for its own multi-section bundle.
 */
router.put(
  "/file",
  requireAnyPermission(
    "admin.people.assign", "admin.people.override",
    "admin.presets.create", "admin.presets.edit", "admin.presets.delete",
  ),
  async (req: Request, res: Response) => {
  const { file, sha, summary } = req.body ?? {};

  if (typeof summary !== "string" || summary.trim().length === 0 || summary.length >= 200) {
    res.status(400).json({ error: "summary must be a non-empty string under 200 characters" });
    return;
  }

  try {
    /**
     * Off by default, exactly like the gate above: with `PERMISSIONS_ENABLED`
     * unset this has to stay inert, or an install that never turned the
     * subsystem on would start losing writes to a check nobody asked for.
     */
    if (PERMISSIONS_ENABLED()) {
      // The same cached read `requireAnyPermission` just made.
      const access = await accessForSelf(req.user!.login, req.user!.accessToken);

      // No organization, no file, nothing to decide — same as the gate.
      if (!access.inert) {
        if (access.failure) {
          res.status(503).json({
            code: "PERMISSIONS_UNAVAILABLE",
            error: `Permissions could not be read, so this cannot be allowed or refused. ${access.failure.detail}`,
          });
          return;
        }

        const loadedBefore = await loadPermissions();
        const before = isFailure(loadedBefore) ? emptyFile() : loadedBefore.file;
        const required = changeClasses(before, file as PermissionsFile);
        const missing = required.find(key => !access.permissions.has(key));
        if (missing) {
          res.status(403).json({
            code: "PERMISSION_REQUIRED",
            permission: missing,
            error: `This change needs the "${missing}" permission, which you do not have.`,
          });
          return;
        }
      }
    }

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

/**
 * What one preset's `inherits` chain grants, leaf by leaf — the same
 * `explanations` shape `GET /person/:login` returns, computed by the
 * server's own `resolvePreset` rather than a client-side port of it.
 *
 * Resolves from the *stored* file, which is what lets the Presets editor ask
 * this for a chain it has not saved yet: `:id` names whichever existing
 * preset the `inherits` field currently points at, not the preset being
 * edited itself.
 */
router.get("/preset/:id/resolved", requirePermission("admin.presets.read"), async (req: Request<{ id: string }>, res: Response) => {
  try {
    const loaded = await loadPermissions();
    const file = isFailure(loaded) ? emptyFile() : loaded.file;
    const explanations = explainPreset(file.presets ?? {}, req.params.id);
    const held = Object.entries(explanations).filter(([, e]) => e.held).map(([key]) => key).sort();

    res.json({ presetId: req.params.id, held, explanations });
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

// Writes a whole file too, but never over one `changeClasses` could be asked
// to diff: it only ever creates an *empty* file, so there is nothing here to
// launder a people/preset change past that check.
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

/**
 * Who the organization currently is, for the migration and its dry-run.
 *
 * Every member, plus their standing under the two legacy teams and org
 * ownership — the same three facts `migrate.ts` needs to reproduce today's
 * access exactly. Read with the App token, the same one every other read in
 * this router uses, so this does not depend on the caller's own visibility
 * into a team they may not be on.
 */
async function buildMemberSnapshots(): Promise<MemberSnapshot[]> {
  const org = getOrg();
  const octokit = createOctokit(getSystemToken(), "Permissions");

  const members = await listOrgMembers(depsFromOctokit(octokit), org);

  const owners = new Set<string>();
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.orgs.listMembers({ org, role: "admin", per_page: 100, page });
    for (const m of data) if (m.login) owners.add(m.login.toLowerCase());
    if (data.length < 100) break;
  }

  const teamMembers = async (slug: string): Promise<Set<string>> => {
    const set = new Set<string>();
    for (let page = 1; ; page++) {
      let data: Array<{ login?: string }>;
      try {
        const res = await octokit.rest.teams.listMembersInOrg({ org, team_slug: slug, per_page: 100, page });
        data = res.data;
      } catch (err: any) {
        if ((err?.status ?? err?.response?.status) === 404) break; // no such team
        throw err;
      }
      for (const m of data) if (m.login) set.add(m.login.toLowerCase());
      if (data.length < 100) break;
    }
    return set;
  };

  const [controlHubAdmins, awsAdmins] = await Promise.all([
    teamMembers(CONTROL_HUB_ADMIN_TEAM),
    teamMembers(AWS_ADMIN_TEAM),
  ]);

  return members.map(m => {
    const key = m.login.toLowerCase();
    return {
      login: m.login,
      isControlHubAdmin: controlHubAdmins.has(key),
      isAwsAdmin: awsAdmins.has(key),
      isOrgOwner: owners.has(key),
    };
  });
}

router.get("/dry-run", requirePermission("admin.people.read"), async (_req: Request, res: Response) => {
  try {
    const loaded = await loadPermissions();
    const currentFile = isFailure(loaded) ? emptyFile() : loaded.file;
    const members = await buildMemberSnapshots();
    res.json(dryRun(currentFile, members));
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

// Writes a whole file too, but refuses outright when `permissions.json`
// already names anyone (see the 409 below) — so it can only ever generate a
// starting file for an organization that has none, never overwrite one
// `changeClasses` could be asked to diff a real people/preset change past.
router.post("/migrate", requirePermission("admin.people.assign"), async (req: Request, res: Response) => {
  try {
    const loaded = await loadPermissions();
    const currentFile = isFailure(loaded) ? emptyFile() : loaded.file;

    // Refuse rather than clobber: regenerating a starting file over one that
    // already names people would silently discard whatever an administrator
    // had already curated.
    if (Object.keys(currentFile.people ?? {}).length > 0) {
      res.status(409).json({
        code: "conflict",
        error: "permissions.json already has people in it; refusing to overwrite it with a generated starting file.",
      });
      return;
    }

    const members = await buildMemberSnapshots();
    const file = startingFile(members);
    const sha = isFailure(loaded) ? null : loaded.sha;

    const result = await savePermissions(file, sha, req.user!.login, "Generate the starting permissions file");
    if (!result.ok) {
      if (result.reason === "conflict") {
        res.status(409).json({ code: "conflict", error: result.detail });
        return;
      }
      if (result.reason === "invalid") {
        res.status(400).json({ error: result.detail, problems: fileProblems(file) });
        return;
      }
      res.status(502).json({ error: result.detail });
      return;
    }

    res.json({ ok: true, sha: result.sha, people: Object.keys(file.people).length });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

export default router;
