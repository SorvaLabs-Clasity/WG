import { Router, Request, Response } from "express";
import { sanitizeError } from "../utils/errorSanitizer";
import { requirePermission, requireAnyPermission } from "../middleware/permissionGate";
import { requireControlHubAdmin } from "../middleware/teamGate";
import {
  loadPermissions, savePermissions, isFailure, unknownNodesIn, fileProblems,
  forgetPermissions, accessForSelf, accessForOther, PERMISSIONS,
  changeClasses, explainPreset, subjectFor,
  enforcementActive,
} from "../permissions";
import { permissionsFor, inheritedStanding, presetStanding } from "../permissions/evaluate";
import { VOCABULARY_VERSION } from "../permissions/vocabulary";
import { emptyFile, type PermissionsFile } from "../permissions/types";
import { PERMISSIONS_REPO, PERMISSIONS_PATH } from "../permissions/store";
import { startingFile, dryRun, type MemberSnapshot } from "../permissions/migrate";
import { createOctokit, getSystemToken, getOrg } from "../github/client";
import { listOrgMembers, depsFromOctokit } from "../services/orgMembersService";
import { CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } from "../services/authorizationService";
import { resolveAccounts } from "../aws-guardrails/accounts";
import { currentVocabulary, setConfiguredAccounts, isAccountId } from "../permissions/accountScope";

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
 * below are inert until a permissions file exists in the organization.
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
router.use((req, res, next) => {
  /**
   * Two gates, one at a time, because they answer in different worlds.
   *
   * With enforcement **off** the permission gates below are `return next()`,
   * so this team check is the only thing standing in front of a router that
   * rewrites `permissions.json` and creates repositories. Without it the tab
   * is live for every signed-in member.
   *
   * With enforcement **on** the permission gates decide, and this one must
   * step aside — otherwise only the admin team can reach the router, and every
   * member of that team holds every permission by membership, which would make
   * `admin.people.assign` and `admin.presets.edit` distinctions nobody can
   * ever be on the wrong side of. The five-way split exists so that somebody
   * can be given `admin.audit.read` and nothing else; that person is by
   * definition not on the team.
   *
   * Team members still reach it once enforcement is on: holding everything
   * includes holding `admin.console.open`.
   */
  accessForSelf(req.user!.login, req.user!.accessToken)
    .then(access => access.inert
      // Nothing written yet, so the permission gates below decide nothing and
      // this team check is the only thing in front of the router.
      ? requireControlHubAdmin(req, res, next)
      : next())
    .catch(() => requireControlHubAdmin(req, res, next));
});

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
 * Inert until a file exists, like every other permission decision
 * in this router: the legacy team gate above is what is deciding then, and it
 * admits nobody who is not a Control Hub administrator.
 */
async function readableSections(
  req: Request, file: PermissionsFile,
): Promise<{ file: PermissionsFile; withheld: string[] }> {
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
 * The one way this router writes `permissions.json`.
 *
 * **No write may widen the writer.** `docs/auth/permissions-model.md` states
 * that without qualification — "it closes the ones nobody has thought of yet" —
 * and it was implemented on `PUT /file` alone. `POST /migrate` also writes a
 * whole file, and the file it writes hands the `control-hub-admin` preset, the
 * entire `admin` branch, to everybody on `control-hub-admins`, which after the
 * team gate above is everybody who can reach the route at all. One call took a
 * caller holding `admin.people.assign` to all ninety-three leaves. `POST
 * /bootstrap` is a third write path, and a fourth added later would be a fourth
 * place to remember.
 *
 * So the rule lives on *writing the file* rather than on one route. Every write
 * path in this router goes through here, and `savePermissions` is imported
 * nowhere else in it; a route that calls it directly is the thing to look for
 * in review.
 *
 * What it asks is what `PUT /file` asked: what do *I* hold under the stored
 * file, and what would I hold under the one being written, per `permissionsFor`
 * — the same evaluator the gates use — over the caller's real subject. It
 * permits an administrator to narrow themselves and to edit a preset they hold
 * in ways that do not widen them. Nobody is exempt from it — organization
 * owners used to be, because they held everything and so had nothing to widen
 * into, and now they hold whatever the file says like anybody else. Members of
 * the admin team still hold everything, so for them it is a rule with nothing
 * to catch rather than an exemption from one.
 *
 * Inert until a file exists, like every other permission decision
 * in this router.
 */
type Written =
  | { ok: true; sha: string }
  | { ok: false; status: number; body: Record<string, unknown> };

async function writeFile(
  req: Request, before: PermissionsFile, toSave: PermissionsFile,
  sha: string | null, summary: string,
): Promise<Written> {
  if (await enforcementActive()) {
    /**
     * Nobody on the Control Hub admin team is configurable.
     *
     * `permissionsFor` gives them everything on the strength of their
     * membership, so an entry naming one of them decides nothing — and an
     * entry that looks like it governs somebody while deciding nothing is
     * worse than no entry at all. It reads as a restriction that is quietly
     * not in force.
     *
     * Refused on the way in rather than stripped silently, because an
     * administrator who has just spent a minute un-ticking boxes deserves to
     * be told that the person they were editing is exempt and why.
     */
    /**
     * Work out *what changed* first, and only then ask who is exempt.
     *
     * The exempt check costs a GitHub call. Asking it about every login in the
     * file meant every save paid for it — including saves that touch no person
     * at all, like editing a preset or declaring an AWS account, which is the
     * commonest kind of save there is.
     */
    const changed = [...new Set([
      ...Object.keys(before.people ?? {}), ...Object.keys(toSave.people ?? {}),
    ])].filter(login =>
      JSON.stringify((before.people ?? {})[login] ?? null)
        !== JSON.stringify((toSave.people ?? {})[login] ?? null));

    const exempt = await controlHubAdminsIn(new Set(changed));
    const touched = changed.filter(login => exempt.has(login));

    if (touched.length > 0) {
      return {
        ok: false, status: 409,
        body: {
          code: "EXEMPT_SUBJECT",
          logins: touched,
          error: `${touched.join(", ")} ${touched.length === 1 ? "is" : "are"} on `
            + `${CONTROL_HUB_ADMIN_TEAM}, which already holds every permission. `
            + "Entries here would decide nothing. To narrow what they can do, take them off "
            + "that team on GitHub.",
        },
      };
    }

    const subject = await subjectFor(req.user!.login, { ownToken: req.user!.accessToken });

    /**
     * A subject whose teams could not be read is not a subject with no teams.
     *
     * `subjectFor` catches a failed team listing and answers with an empty
     * list. The comparison below then computes **both** sides against a
     * teamless subject, so a write granting `admin` to a team the caller is in
     * registers as no gain and is written — a transient failure on `GET
     * /user/teams` is the whole precondition. It is the same window `PUT
     * /file`'s unreadable-store check was fixed for, and it has to fail the
     * same way: an outage, not a decision. 503 is what the gate above answers
     * when it cannot establish the caller's standing either.
     */
    if (subject.teamsUnavailable) {
      return {
        ok: false, status: 503,
        body: {
          code: "PERMISSIONS_UNAVAILABLE",
          error: "Your own GitHub team membership could not be read, so this change cannot be "
            + "checked against what you already hold and will not be written. Try again.",
        },
      };
    }

    if (!subject.isOrgOwner) {
      const nowHeld = permissionsFor(before, subject);
      const wouldHold = permissionsFor(toSave, subject);
      const gained = wouldHold.held.filter(leaf => !nowHeld.has(leaf));

      if (gained.length > 0) {
        return {
          ok: false, status: 403,
          body: {
            code: "SELF_WIDENING",
            gained,
            error: "This change would give you permissions you do not hold: "
              + `${gained.slice(0, 6).join(", ")}${gained.length > 6 ? `, and ${gained.length - 6} more` : ""}. `
              + "Nobody may widen their own access; ask another administrator to make this change.",
          },
        };
      }
    }
  }

  // sha is the blob the editor loaded; savePermissions refuses rather than
  // clobbering a concurrent edit if it has moved on.
  /**
   * The caller's own token, so GitHub decides whether they may write this
   * repository — and so the commit is authored by them. Every write path in
   * this router goes through here, which is why the token is threaded once.
   */
  const result = await savePermissions(toSave, sha, req.user!.login, summary, req.user!.accessToken);
  if (result.ok) return { ok: true, sha: result.sha };
  if (result.reason === "conflict") {
    return { ok: false, status: 409, body: { code: "conflict", error: result.detail } };
  }
  if (result.reason === "invalid") {
    return { ok: false, status: 400, body: { error: result.detail, problems: fileProblems(toSave) } };
  }
  return { ok: false, status: 502, body: { error: result.detail } };
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
     * What the change is diffed against, and what `writeFile` compares the
     * caller's own standing across. Only ever read — and only ever needed —
     * inside the enforcement branch below; an empty file here is never used as
     * a baseline, because `writeFile` does not look at it with the flag unset.
     */
    let before: PermissionsFile = emptyFile();

    /**
     * Off until a file exists, exactly like the gate above: with no file
     * unset this has to stay inert, or an install that never turned the
     * subsystem on would start losing writes to a check nobody asked for.
     */
    if (await enforcementActive()) {
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

        before = loadedBefore.file;

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
         * The self-widening rule that used to live here is now in `writeFile`
         * below, which every write path in this router goes through — see its
         * docblock. `changeClasses` derives what a write *does*; nothing here
         * derives who it was done *to*, and that was the hole: a holder of
         * `admin.people.assign` alone could add the shipped `control-hub-admin`
         * preset to their own entry and the diff classified as exactly
         * `admin.people.assign`.
         */
      }
    }

    const written = await writeFile(req, before, toSave, sha ?? null, summary);
    if (written.ok) {
      res.json({ ok: true, sha: written.sha });
      return;
    }
    res.status(written.status).json(written.body);
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

// So the tree renders from the server's own list rather than a copy that can
// drift from it as the vocabulary grows.
router.get("/vocabulary", requirePermission("admin.console.open"), async (_req: Request, res: Response) => {
  /**
   * Refreshed here rather than cached at boot, because an account added this
   * morning has to be grantable this morning — and this is the one request
   * that exists to tell the tree what can be granted. Everything else reads
   * the registry.
   *
   * A failure to resolve accounts is not fatal: the fixed leaves are still the
   * whole of the non-AWS vocabulary, and the global `aws.*` keys still answer
   * for every account. The tree shows no per-account branch, which is honest —
   * it does not know of any.
   */
  /**
   * Two sources, deliberately.
   *
   * `resolveAccounts` knows the account the app is actually running in.
   * `awsAccounts` in the permissions file is what an administrator has
   * *declared* — accounts the organization wants to scope permissions by,
   * whether or not the app can reach them yet. Credentials are a separate
   * problem; the permission tree only needs to know an account exists.
   *
   * Declaring one is therefore useful before any of the plumbing works: you
   * can write "remediate in sandbox, read-only in prod" today and have it
   * mean something the moment prod is wired up.
   */
  let accountsFailed: string | null = null;
  let live: Array<{ accountId: string; name: string }> = [];
  try {
    live = (await resolveAccounts()).map(a => ({ accountId: a.accountId, name: a.name }));
  } catch (err: any) {
    accountsFailed = err?.message ?? String(err);
  }

  const loaded = await loadPermissions();
  const declared = (isFailure(loaded) ? [] : loaded.file.awsAccounts ?? [])
    .filter(a => isAccountId(a.accountId));

  // Declared names win: somebody typed them on purpose.
  const merged = new Map<string, { accountId: string; name: string }>();
  for (const a of live) merged.set(a.accountId, a);
  for (const a of declared) merged.set(a.accountId, { accountId: a.accountId, name: a.name });

  setConfiguredAccounts([...merged.keys()]);

  res.json({
    permissions: currentVocabulary(),
    version: VOCABULARY_VERSION,
    /**
     * So the tree can label `aws.account.<id>` with the name people use — an
     * estate of raw twelve-digit numbers is unreadable, and picking the wrong
     * one is how somebody grants remediation in production.
     */
    accounts: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    /** Which of them the app can actually reach today, so the screen can say so. */
    liveAccountIds: live.map(a => a.accountId),
    accountsFailed,
  });
});

/**
 * One person's standing, and the baseline the admin tree edits against.
 *
 * `explanations` says which rule won overall, leaf by leaf, and that is a
 * different question from the one the tree asks. The tree edits **one layer** —
 * this person's own `grant`/`revoke` — and writes the shortest entry expressing
 * the difference from everything beneath it, so what it needs is "what would
 * they hold if their own entry were empty".
 *
 * The client used to derive that from `explanations`, by dropping every leaf
 * whose origin read `set on this person` and flattening the rest to leaf depth.
 * Both halves were wrong, and each produced a silent, dangerous write:
 *
 *   - A leaf this person's own `revoke` was suppressing came back as "not
 *     granted" — indistinguishable from a leaf nothing grants — so the revoke
 *     agreed with the baseline, no rule was emitted for it, and the next
 *     unrelated tick rewrote the entry without it. Fifteen AWS leaves came back
 *     while the screen went on showing fourteen of them unticked.
 *   - Flattening to leaf depth inverted `decideLeaf` on the client: a person's
 *     collapsed `revoke: ["aws"]` lost to the client's leaf-depth inherited
 *     grants and won against the server's real `aws`, so un-ticking a branch
 *     moved no checkbox on screen and revoked fourteen leaves on save.
 *
 * So the server answers the question the tree actually asks, from the same
 * evaluator that will decide it in production: `inherited`, every rule beneath
 * this person at the depth it was written, and `baseline`, what those rules
 * alone decide. Whatever the tree saves then resolves, through `permissionsFor`,
 * to exactly the set the administrator saw ticked.
 */
router.get("/person/:login", requirePermission("admin.people.read"), async (req: Request<{ login: string }>, res: Response) => {
    try {
      // accessForOther, never accessForSelf: this is an administrator asking
      // about somebody else, and accessForSelf would attribute the caller's
      // own teams to the login being inspected.
      /**
       * Bounded by the teams that can matter, for the same reason as the
       * subject build below: unbounded, this is one GitHub call per team in
       * the organization every time somebody opens a person.
       */
      const forBound = await loadPermissions();
      const access = await accessForOther(req.params.login, [
        CONTROL_HUB_ADMIN_TEAM,
        ...(isFailure(forBound) ? [] : Object.keys(forBound.file.teams ?? {})),
      ]);

      const explanations: Record<string, ReturnType<typeof access.permissions.explain>> = {};
      for (const leaf of PERMISSIONS) {
        explanations[leaf.key] = access.permissions.explain(leaf.key);
      }

      /**
       * Both of these are the reads `accessForOther` just made, answered from
       * the same one-minute caches, so this costs no extra GitHub call. Read
       * from the file rather than from `access`, because `access` applies the
       * organization-owner exemption and the tree is editing the file.
       */
      /**
       * The file is read first, so the subject build can be told which teams
       * can possibly matter: the ones the file itself names, plus the admin
       * team, which is the total exemption. Without that list this call lists
       * every team in the organization and asks a membership question per team
       * — one GitHub call per team, per person opened, which is the burst that
       * trips GitHub's secondary rate limit after a few clicks.
       */
      const loaded = await loadPermissions();
      const relevantTeams = [
        CONTROL_HUB_ADMIN_TEAM,
        ...(isFailure(loaded) ? [] : Object.keys(loaded.file.teams ?? {})),
      ];
      const subject = await subjectFor(req.params.login, { relevantTeams });
      const stored = isFailure(loaded) ? emptyFile() : loaded.file;
      const { rules, baseline } = inheritedStanding(stored, subject);

      res.json({
        login: req.params.login,
        held: access.permissions.held,
        explanations,
        inherited: rules.map(r => ({ node: r.node, effect: r.effect, layer: r.layer, origin: r.origin })),
        baseline,
        /**
         * True when this person's GitHub teams could not be read, so `baseline`
         * is missing whatever their teams grant.
         *
         * This is not a display caveat. The tree saves the difference between
         * what is ticked and this baseline, so a baseline that understates what
         * the teams grant makes the person's own `revoke` look redundant — and
         * the next unrelated tick drops it, handing back everything that revoke
         * was suppressing. That is exactly the defect this endpoint's baseline
         * was added to fix, reachable through one transient GitHub failure.
         *
         * The client must refuse to save a permission edit while this is true.
         */
        teamsUnavailable: subject.teamsUnavailable === true,

        /**
         * On the Control Hub admin team, so they hold everything by membership
         * and nothing written here about them decides anything. The screen
         * shows the tree read-only and says why, rather than letting somebody
         * compose a restriction that would never take effect.
         */
        exempt: subject.teamSlugs.includes(CONTROL_HUB_ADMIN_TEAM),
      });
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

    // The same pair `GET /person/:login` returns, for the Presets editor's own
    // tree: the chain's rules at the depth they were written, and what they
    // alone decide. A preset's tree edits its own layer against its parent's
    // exactly the way a person's edits theirs against their teams.
    const { rules, baseline } = presetStanding(file.presets ?? {}, req.params.id);

    res.json({
      presetId: req.params.id,
      held,
      explanations,
      inherited: rules.map(r => ({ node: r.node, effect: r.effect, layer: r.layer, origin: r.origin })),
      baseline,
    });
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
// launder a people/preset change past that check. It still goes through
// `writeFile` rather than `savePermissions`, because "this particular write
// cannot widen anybody" is a fact about today's code and not a property of the
// route, and the next person to edit it should not have to rediscover that.
router.post("/bootstrap", requirePermission("admin.people.assign"), async (req: Request, res: Response) => {
  const createRepo = req.body?.createRepo === true;

  try {
    let loaded = await loadPermissions();
    let repoCreated = false;
    let teamGranted = false;
    let teamGrantError: string | null = null;

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
      /**
       * `auto_init` is not a nicety. A repository created without it has no
       * commits at all, and the Contents API answers 409 on an empty
       * repository — which `savePermissions` then reported as "somebody else
       * saved while this was open", on a repository nobody had ever written
       * to. The first thing an operator did after creating the repo was the
       * migration, so the first thing they saw was that.
       *
       * A repository with one commit is also what the branch ruleset in
       * `docs/operations/setup.md` needs to target: there is no default branch
       * to protect until something has been committed to it.
       */
      await octokit.rest.repos.createInOrg({
        org: getOrg(), name: PERMISSIONS_REPO, private: true,
        auto_init: true,
        description: "Who may do what in the Control Hub. Written by the app; do not edit by hand.",
      });
      repoCreated = true;

      /**
       * Give the admin team push access to what was just created.
       *
       * Administrators write this file with their own tokens, so a repository
       * created without this is one nobody can write to — bootstrap would
       * succeed and the very next step, the migration, would fail with "GitHub
       * refused to let you write". The team that gates this screen is exactly
       * the set that should be able to commit, so granting it here is the
       * whole configuration rather than a shortcut around it.
       *
       * Not fatal if it fails: an organization can grant the access by hand,
       * and reporting a half-made repository is better than unmaking it.
       */
      try {
        await octokit.rest.teams.addOrUpdateRepoPermissionsInOrg({
          org: getOrg(), team_slug: CONTROL_HUB_ADMIN_TEAM,
          owner: getOrg(), repo: PERMISSIONS_REPO, permission: "push",
        });
        teamGranted = true;
      } catch (err: any) {
        teamGrantError = err?.message ?? String(err);
      }

      forgetPermissions();
      loaded = await loadPermissions();
    }

    if (isFailure(loaded)) {
      res.status(502).json({ repoCreated, teamGranted, teamGrantError, fileCreated: false, failure: loaded });
      return;
    }

    let fileCreated = false;
    if (loaded.source === "absent" || loaded.source === "no-repo") {
      const written = await writeFile(req, loaded.file, emptyFile(), null, "Initialise permissions");
      if (!written.ok) {
        res.status(written.status).json({ repoCreated, teamGranted, teamGrantError, fileCreated: false, ...written.body });
        return;
      }
      fileCreated = true;
    }

    res.json({ repoCreated, teamGranted, teamGrantError, fileCreated });
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
     * It then still ignored `teams`, which is the third table and the one
     * `docs/auth/permissions-model.md` encourages authority to be delivered
     * through: a file whose whole content was `teams` had both guarded tables
     * empty, passed, and had the team that was granting the caller their one
     * permission erased and replaced with a preset granting them the lot.
     *
     * `startingFile` replaces all three, so any of the three being non-empty
     * means there is something to discard, and any of the three refuses.
     */
    const occupied = (["people", "presets", "teams"] as const)
      .filter(section => Object.keys(currentFile[section] ?? {}).length > 0);
    if (occupied.length > 0) {
      const what = occupied.length === 1 ? occupied[0]
        : `${occupied.slice(0, -1).join(", ")} and ${occupied[occupied.length - 1]}`;
      res.status(409).json({
        code: "conflict",
        error: `permissions.json already has ${what} in it; refusing to overwrite it with a generated starting file.`,
      });
      return;
    }

    const members = await buildMemberSnapshots();
    const file = startingFile(members);
    const sha = isFailure(loaded) ? null : loaded.sha;

    const written = await writeFile(req, currentFile, file, sha,
      "Generate the starting permissions file");
    if (!written.ok) {
      res.status(written.status).json(written.body);
      return;
    }

    res.json({ ok: true, sha: written.sha, people: Object.keys(file.people).length });
  } catch (err) {
    res.status(500).json({ error: sanitizeError(err, "admin") });
  }
});

/**
 * Everybody in the organization, for the People screen's search.
 *
 * The screen used to search `permissions.json` alone, so the only people it
 * could offer were the ones somebody had already granted something. Adding
 * anybody new meant typing their login exactly right, from memory, with no
 * confirmation that the account existed — and a typo created an entry that
 * would never match anyone, silently.
 *
 * Gated on `admin.people.read`, which is the permission for seeing who holds
 * what. The roster itself is not privileged — every member can see the
 * organization's people on github.com — but the screen it feeds is.
 */
router.get("/org-members", requirePermission("admin.people.read"), async (_req: Request, res: Response) => {
  try {
    const octokit = createOctokit(getSystemToken(), "Permissions");
    const [members, admins] = await Promise.all([
      listOrgMembers(depsFromOctokit(octokit), getOrg()),
      membersOfTeam(octokit, CONTROL_HUB_ADMIN_TEAM),
    ]);

    res.json({
      // `listOrgMembers` already sorts case-insensitively and de-duplicates
      // across pages; it is the same read `/dry-run` and `/migrate` make, so
      // this costs no call they do not already make.
      //
      // `exempt` marks the Control Hub admins, who hold everything by
      // membership and cannot be configured here. One team read for the whole
      // roster, not one per person.
      members: members.map(m => ({
        login: m.login,
        avatarUrl: m.avatarUrl,
        exempt: admins.has(m.login.toLowerCase()),
      })),
    });
  } catch (err) {
    res.status(502).json({ error: sanitizeError(err, "admin") });
  }
});

/**
 * The members of one team, in one paginated read.
 *
 * A team that cannot be read answers empty rather than throwing: the callers
 * either mark nobody exempt — which shows them as configurable, and the write
 * path checks again — or refuse nothing, which is the same answer they gave
 * before any of this existed. A save must not fail because a team listing
 * blinked.
 */
async function membersOfTeam(octokit: any, slug: string): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    for (let page = 1; ; page++) {
      const { data } = await octokit.rest.teams.listMembersInOrg({
        org: getOrg(), team_slug: slug, per_page: 100, page,
      });
      for (const m of data) if (m.login) set.add(m.login.toLowerCase());
      if (data.length < 100) break;
    }
  } catch {
    // A team that cannot be read marks nobody exempt, which shows them as
    // configurable. The write path checks again and refuses, so the worst case
    // is a save that is refused rather than an exemption silently lost.
  }
  return set;
}

async function controlHubAdminsIn(logins: Set<string>): Promise<Set<string>> {
  if (logins.size === 0) return new Set();

  /**
   * One call: the team's members, intersected with the logins asked about.
   *
   * This used to ask `subjectFor(login)` per login. For somebody who is not
   * the caller that runs the App-token path, whose own docblock says it costs
   * one GitHub call **per team in the organization** and "if it ever becomes a
   * per-request cost, it is the wrong implementation". It became exactly that:
   * every write compares the people in the stored file with the people in the
   * proposed one, and after the migration that is every member of the
   * organization — so a single save cost members × teams calls and emptied the
   * App's rate limit in two or three saves. The file then read as unreachable,
   * which is a permissions outage caused by saving permissions.
   *
   * Asking the team who its members are answers the same question in one
   * paginated call, whatever the size of the organization.
   */
  const octokit = createOctokit(getSystemToken(), "Permissions");
  const members = await membersOfTeam(octokit, CONTROL_HUB_ADMIN_TEAM);
  return new Set([...logins].filter(login => members.has(login.toLowerCase())));
}

export default router;
