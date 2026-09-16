import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { requirePermission, requireAnyPermission, PERMISSIONS_ENABLED } from "../middleware/permissionGate";
import { requireControlHubAdmin } from "../middleware/teamGate";
import {
  loadPermissions, savePermissions, isFailure, unknownNodesIn, fileProblems,
  forgetPermissions, accessForSelf, accessForOther, PERMISSIONS,
  changeClasses, explainPreset, subjectFor,
} from "../permissions";
import { permissionsFor } from "../permissions/evaluate";
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

/**
 * The legacy team gate, in front of everything, because the permission gates
 * below are inert until `PERMISSIONS_ENABLED` is flipped.
 *
 * Every other privileged router in this repo keeps its team gate *as well as*
 * its new permission gate — `access.ts`, `alarms.ts`, `pulls.ts`, `config.ts` —
 * precisely so the flag can ship off safely. This router shipped without one,
 * which left every route here open to any signed-in organization member: the
 * whole of `permissions.json`, the write that rewrites it, and a `POST
 * /bootstrap` that creates a repository in the organization.
 *
 * `router.use` rather than a guard repeated on each route, so a route added
 * later inherits it instead of having to remember it. It is also the sentence
 * `docs/operations/setup.md` already claimed was implemented:
 * `control-hub-admins` gates the Admin tab, which is now that team's only
 * remaining meaning.
 */
router.use(requireControlHubAdmin);

// People and Presets both render from this one file, so either read
// permission has to be enough to load it — gating it on admin.people.read
// alone would 403 somebody who holds only admin.presets.read before they
// ever reach the Presets tab.
router.get("/file", requireAnyPermission("admin.people.read", "admin.presets.read"), async (req: Request, res: Response) => {
  try {
    const loaded = await loadPermissions();

    // A read failure is returned as 200, not an error. The Admin tab's whole
    // job is to fix a broken file, so it has to be able to see one when it
    // cannot be used — a 5xx here would hide the exact screen that repairs it.
    if (isFailure(loaded)) {
      res.json({ failure: loaded });
      return;
    }

    const { file, withheld } = await readableSections(req, loaded.file);

    res.json({
      file,
      sha: loaded.sha,
      source: loaded.source,
      // Derived from what this caller may see, not from the whole file: a
      // problem reads `people.someone`, which names a login, and an unknown
      // node names what somebody wrote against it.
      unknownNodes: unknownNodesIn(file),
      problems: fileProblems(file),
      ...(withheld.length ? { withheld } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

/**
 * Which halves of the file this caller may see.
 *
 * `GET /file` is reachable with either read permission because People and
 * Presets render from the one file — and it used to answer with the whole of
 * it, so a holder of `admin.presets.read` alone received every person's
 * grants, revokes and free-text notes ("Why does this person hold what they
 * hold?"). Hiding the People *tab* in the client is not the same thing: the
 * data had already crossed the wire. `docs/auth/permissions-model.md` states
 * the rule twice — "a card whose data you may not read is **absent, not
 * empty**", and "the same rule applies anywhere one screen surfaces
 * another's data".
 *
 * A withheld section is left off the object rather than blanked, and named in
 * `withheld`, so the screen can say "not shown to you" instead of "nobody".
 *
 * Inert with `PERMISSIONS_ENABLED` unset, like every other permission decision
 * in this router: the legacy team gate above is what is deciding then, and it
 * admits nobody who is not a Control Hub administrator.
 */
async function readableSections(
  req: Request, file: PermissionsFile,
): Promise<{ file: PermissionsFile; withheld: string[] }> {
  if (!PERMISSIONS_ENABLED()) return { file, withheld: [] };

  const access = await accessForSelf(req.user!.login, req.user!.accessToken);
  if (access.inert) return { file, withheld: [] };

  const out: PermissionsFile = { ...file };
  const withheld: string[] = [];

  // `failure` cannot reach here — the gate answers 503 first — and if one ever
  // did, `permissions` is empty and both sections are withheld, which is the
  // right way round.
  for (const [section, key] of [["people", "admin.people.read"], ["presets", "admin.presets.read"]] as const) {
    if (access.permissions.has(key)) continue;
    delete (out as unknown as Record<string, unknown>)[section];
    withheld.push(section);
  }

  return { file: out, withheld };
}

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
    let toSave = file as PermissionsFile;

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

        /**
         * A store failure is not an empty file.
         *
         * This used to fall back to `emptyFile()`, which made the diff below
         * run against nothing: a submission that wipes every preset and every
         * person requires `["admin.people.assign", "admin.presets.delete"]`
         * against the stored file and `[]` against an empty one, so the 403
         * was skipped and the wipe was written — and deny-by-default then
         * means the organization has locked itself out. Closed, and said as an
         * outage, which is what the gate above already answers.
         */
        if (isFailure(loadedBefore)) {
          res.status(503).json({
            code: "PERMISSIONS_UNAVAILABLE",
            error: "The stored permissions file could not be read, so this change cannot be "
              + `checked against it and will not be written. ${loadedBefore.detail}`,
          });
          return;
        }

        const before = loadedBefore.file;

        /**
         * A section withheld on the way out comes back on the way in.
         *
         * `GET /file` gives somebody holding only `admin.presets.read` a file
         * with no `people` in it, and the screen submits the file it was
         * given — so taking that at face value would delete every person in
         * the organization on the next preset edit. The stored section is put
         * back before anything is diffed or saved.
         *
         * Only when the section is genuinely **absent**, and only when this
         * caller could not read it. A section they submitted is judged
         * normally, by the diff, whatever they may read: quietly reverting an
         * edit somebody made is worse than refusing it, and a deliberate wipe
         * by somebody who *can* see what they are wiping is a real change that
         * must ask for the permission it needs.
         */
        toSave = { ...toSave };
        if (toSave.people === undefined && !access.permissions.has("admin.people.read")) {
          toSave.people = before.people;
        }
        if (toSave.presets === undefined && !access.permissions.has("admin.presets.read")) {
          toSave.presets = before.presets;
        }

        const required = changeClasses(before, toSave);
        const missing = required.find(key => !access.permissions.has(key));
        if (missing) {
          res.status(403).json({
            code: "PERMISSION_REQUIRED",
            permission: missing,
            error: `This change needs the "${missing}" permission, which you do not have.`,
          });
          return;
        }

        /**
         * **No write may widen the writer.**
         *
         * `changeClasses` derives what a write *does*; nothing derived who it
         * was done *to*. A holder of `admin.people.assign` alone could add the
         * shipped `control-hub-admin` preset — which grants the whole `admin`
         * branch — to their own entry: the diff classifies as exactly
         * `admin.people.assign`, so it was permitted, and afterwards they held
         * all five admin write permissions. The symmetric path existed for
         * `admin.presets.edit`: edit a preset you hold to add `grant:
         * ["admin"]`. The five-way split is this stage's headline deliverable
         * and both paths collapse it back into one.
         *
         * Enumerating the routes would be a list to keep complete. This asks
         * the question directly instead — what do *I* hold before, and what
         * would I hold after — with `permissionsFor`, the same evaluator the
         * gates use, over the caller's real subject. It permits an
         * administrator to narrow themselves and to edit a preset they hold in
         * ways that do not widen them, and it closes every escalation path
         * including ones nobody has thought of yet.
         *
         * Organization owners are exempt, as they are everywhere else here:
         * they already hold everything, so there is nothing to widen into.
         */
        const subject = await subjectFor(req.user!.login, { ownToken: req.user!.accessToken });
        if (!subject.isOrgOwner) {
          const nowHeld = permissionsFor(before, subject);
          const wouldHold = permissionsFor(toSave, subject);
          const gained = wouldHold.held.filter(leaf => !nowHeld.has(leaf));

          if (gained.length > 0) {
            res.status(403).json({
              code: "SELF_WIDENING",
              gained,
              error: "This change would give you permissions you do not hold: "
                + `${gained.slice(0, 6).join(", ")}${gained.length > 6 ? `, and ${gained.length - 6} more` : ""}. `
                + "Nobody may widen their own access; ask another administrator to make this change.",
            });
            return;
          }
        }
      }
    }

    // sha is the blob the editor loaded; savePermissions refuses rather than
    // clobbering a concurrent edit if it has moved on.
    const result = await savePermissions(toSave, sha ?? null, req.user!.login, summary);

    if (result.ok) {
      res.json({ ok: true, sha: result.sha });
      return;
    }

    if (result.reason === "conflict") {
      res.status(409).json({ code: "conflict", error: result.detail });
      return;
    }

    if (result.reason === "invalid") {
      res.status(400).json({ error: result.detail, problems: fileProblems(toSave) });
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

    /**
     * Refuse rather than clobber.
     *
     * This checked `people` and not `presets`, while `startingFile` replaces
     * the preset table wholesale — so a file holding curated presets and no
     * people passed the guard and had those presets destroyed and three new
     * ones created, by a caller holding only `admin.people.assign`. The
     * identical write through `PUT /file` would have required
     * `admin.presets.delete` and `admin.presets.create` as well, which is
     * exactly the laundering this route's own comment says cannot happen here.
     *
     * Either table being non-empty means there is something to discard, so
     * either one refuses.
     */
    const existingPeople = Object.keys(currentFile.people ?? {}).length;
    const existingPresets = Object.keys(currentFile.presets ?? {}).length;
    if (existingPeople > 0 || existingPresets > 0) {
      const what = existingPeople > 0 && existingPresets > 0 ? "people and presets"
        : existingPeople > 0 ? "people" : "presets";
      res.status(409).json({
        code: "conflict",
        error: `permissions.json already has ${what} in it; refusing to overwrite it with a generated starting file.`,
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
