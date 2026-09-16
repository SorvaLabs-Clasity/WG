/**
 * The Admin tab's routes.
 *
 * This is the one router that can grant permissions, so it is the one whose own
 * gating matters most: a hole here is a hole in everything. It is also the
 * router most likely to be reached by somebody who holds nothing, since the
 * screen exists precisely to give people access.
 *
 * Run:  npx tsx repro-admin.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { PERMISSIONS } from "./src/permissions/vocabulary";
import { startingFile, dryRun } from "./src/permissions/migrate";
import { fileProblems } from "./src/permissions/validate";
import { permissionsFor } from "./src/permissions/evaluate";
import { emptyFile, type PermissionsFile } from "./src/permissions/types";
import { changeClasses } from "./src/permissions/changeClasses";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const admin = fs.readFileSync("./src/routes/admin.ts", "utf8");
const server = fs.readFileSync("./src/server.ts", "utf8");

console.log("the admin router");
{
  check("it is mounted", /\/api\/admin/.test(server) && /adminRoutes/.test(server));

  check("  behind authentication", /app\.use\("\/api\/admin",\s*authMiddleware/.test(server));

  /**
   * People and Presets both render from this one file, so either read
   * permission has to reach it — gating it on admin.people.read alone would
   * 403 somebody who holds only admin.presets.read before they ever saw the
   * Presets tab.
   */
  {
    const at = admin.indexOf('router.get("/file"');
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check('  GET /file needs admin.people.read or admin.presets.read',
      at >= 0 && /requireAnyPermission\(/.test(line)
        && line.includes('"admin.people.read"') && line.includes('"admin.presets.read"'),
      line.trim());
  }

  /**
   * Reading the file means reading who holds what across the organization —
   * the same aggregation the access map is gated on. Writing it is the most
   * privileged act in the app.
   */
  for (const [path, permission] of [
    ['router.get("/vocabulary"', "admin.console.open"],
    ['router.get("/person/:login"', "admin.people.read"],
    ['router.get("/preset/:id/resolved"', "admin.presets.read"],
    ['router.get("/audit"', "admin.audit.read"],
    ['router.post("/bootstrap"', "admin.people.assign"],
  ] as const) {
    const at = admin.indexOf(path);
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check(`  ${path.slice(12)} needs ${permission}`,
      at >= 0 && line.includes(`requirePermission("${permission}")`), line.trim());
  }

  /**
   * `PUT /file` is not "one permission" any more: it receives a whole file,
   * and which of the five admin write permissions it needs depends on what
   * the diff actually contains. The route's own middleware is a coarse
   * `requireAnyPermission` of all five — a cheap rejection of somebody with
   * no admin write authority at all — and the fine-grained refusal happens
   * inside the handler, against `changeClasses`. This checks the coarse gate
   * names every one of the five; the finer behaviour is exercised directly
   * against `changeClasses` below, not by scanning source text for it.
   */
  {
    const at = admin.indexOf('router.put(');
    const handlerAt = admin.indexOf("async (req: Request, res: Response) => {", at);
    const gate = at >= 0 && handlerAt > at ? admin.slice(at, handlerAt) : "";
    check('  PUT /file is gated on requireAnyPermission of all five admin write permissions',
      at >= 0 && /requireAnyPermission\(/.test(gate)
        && ["admin.people.assign", "admin.people.override", "admin.presets.create",
            "admin.presets.edit", "admin.presets.delete"].every(k => gate.includes(`"${k}"`)),
      gate.trim());

    check('  and the handler derives the finer requirement from changeClasses',
      /changeClasses\(/.test(admin) && /PERMISSION_REQUIRED/.test(admin.slice(at)));

    check('  and the fine-grained check is inert while PERMISSIONS_ENABLED is off, like the gate',
      /if \(PERMISSIONS_ENABLED\(\)\)/.test(admin.slice(at, admin.indexOf("savePermissions(", at))));
  }

  /**
   * Inspecting somebody else must not lend them the inspector's teams. Stage 2
   * shipped exactly that bug; the two-function split is what prevents it, and
   * this router is the caller that would reintroduce it.
   */
  check("inspecting another login uses the tokenless call",
    /accessForOther\(/.test(admin) && !/accessForSelf\([^)]*params/.test(admin),
    "accessForSelf with somebody else's login lends them your teams");

  // A save that does not carry the sha it read silently discards a concurrent edit.
  check("saving sends the sha the editor loaded",
    /savePermissions\(/.test(admin) && /sha/.test(admin));

  check("  and a conflict is reported as one, not as a failure",
    /conflict/.test(admin) && /409/.test(admin));

  // The file is validated by savePermissions, but the route should say which
  // entry is wrong rather than passing a bare rejection to the screen.
  check("an invalid file is refused with its problems named",
    /problems/.test(admin));

  /**
   * The two migration endpoints, gated the same way as the rest of the table.
   */
  for (const [path, permission] of [
    ['router.get("/dry-run"', "admin.people.read"],
    ['router.post("/migrate"', "admin.people.assign"],
  ] as const) {
    const at = admin.indexOf(path);
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check(`  ${path.slice(12)} needs ${permission}`,
      at >= 0 && line.includes(`requirePermission("${permission}")`), line.trim());
  }

  // Regenerating a starting file over one that already has people in it would
  // silently discard whatever an administrator had already curated.
  check("migrate refuses to regenerate over a file that already has people in it",
    /migrate/.test(admin) && /409/.test(admin) && /people/.test(admin));
}

console.log("\nthe starting file");
{
  const members = [
    { login: "an-admin", isControlHubAdmin: true, isAwsAdmin: false, isOrgOwner: false },
    { login: "aws-person", isControlHubAdmin: false, isAwsAdmin: true, isOrgOwner: false },
    { login: "an-owner", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: true },
    { login: "everybody-else", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: false },
  ];
  const file = startingFile(members);

  /**
   * Deny by default means switching enforcement on is a cliff: everybody loses
   * everything until the file names them. The starting file exists so that the
   * flip changes nothing on day one — it reproduces today's behaviour, and the
   * narrowing happens afterwards, deliberately, one person at a time.
   */
  check("every member is named", Object.keys(file.people).length === members.length,
    Object.keys(file.people));

  check("there are presets rather than per-person permission lists",
    Object.keys(file.presets).length >= 3, Object.keys(file.presets));

  check("  and every person holds one",
    Object.values(file.people).every(p => (p.presets ?? []).length > 0));

  check("the file it produces is valid", fileProblems(file).length === 0, fileProblems(file));

  // Today's two teams become two presets; everybody else gets the one that
  // reproduces what a plain member can do now.
  const adminAccess = permissionsFor(file, { login: "an-admin", teamSlugs: [], isOrgOwner: false });
  const member = permissionsFor(file, { login: "everybody-else", teamSlugs: [], isOrgOwner: false });
  const aws = permissionsFor(file, { login: "aws-person", teamSlugs: [], isOrgOwner: false });

  check("a Control Hub admin keeps the admin screens", adminAccess.has("access.read"));
  check("  and the AWS person keeps the AWS ones", aws.has("aws.rules.edit"));
  check("  while a plain member does not", !member.has("access.read") && !member.has("aws.rules.edit"));

  /**
   * The part that decides whether the flip is survivable. Reading is a
   * permission now, so a plain member who could open Activity and My work
   * yesterday must still be able to today.
   */
  check("a plain member keeps their own screens",
    member.has("me.work.read") && member.has("me.alarms.manage") && member.has("me.alerts.manage"));
  check("  and the reads that were open to everybody",
    member.has("activity.read.own") && member.has("repos.read") && member.has("pulls.read"));
  check("  but not the ability to change org-wide settings",
    !member.has("alarms.org.create") && !member.has("scanners.manage"));

  // Owners are exempt in the engine; naming them anyway keeps the file a
  // complete picture of the organization rather than a list with holes.
  check("an owner is named too", !!file.people["an-owner"]);
}

console.log("\nthe dry run");
{
  const members = [
    { login: "an-admin", isControlHubAdmin: true, isAwsAdmin: false, isOrgOwner: false },
    { login: "everybody-else", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: false },
  ];

  // An empty file is what the flip would use if nobody ran the migration.
  const rows = dryRun(emptyFile(), members);
  check("with an empty file, everybody loses everything",
    rows.length === 2 && rows.every(r => r.losing.length > 0 && r.keeping === 0), rows);

  // With the starting file, nobody loses anything — that is the whole point.
  const safe = dryRun(startingFile(members), members);
  check("with the starting file, nobody loses anything",
    safe.every(r => r.losing.length === 0), safe.filter(r => r.losing.length));

  check("  and everybody keeps something", safe.every(r => r.keeping > 0));

  check("an owner is reported as exempt rather than as losing nothing by luck",
    dryRun(emptyFile(), [{ login: "o", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: true }])[0]
      .isOrgOwner === true);
}

console.log("\nchangeClasses: what a PUT /file write actually requires");
{
  /**
   * `changeClasses` is what stops the five admin write permissions collapsing
   * back into one: it is asked what a diff *does*, never what endpoint asked
   * for it. Every case here asserts the relationship a diff has to require —
   * "a diff that only touches `note` requires exactly `admin.people.override`"
   * — never a character count or a call shape, which is how several other
   * suites in this repo have already had to be rewritten once before.
   */
  const base = (): PermissionsFile => ({
    version: 1,
    presets: {
      engineer: { name: "Engineer", grant: ["repos.read"] },
      lead: { name: "Lead", inherits: "engineer", grant: ["pulls.mute"] },
    },
    teams: { platform: { presets: ["engineer"] } },
    people: {
      ana: { presets: ["engineer"], grant: ["deps.read"], note: "on the platform team" },
    },
  });

  const eq = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

  check("a no-op write requires nothing",
    changeClasses(base(), base()).length === 0, changeClasses(base(), base()));

  check("reordering a set (a person's presets) is still a no-op",
    changeClasses(base(), {
      ...base(),
      people: { ana: { ...base().people.ana, presets: ["engineer"] } },
    }).length === 0);

  // ── person.presets: admin.people.assign, alone ──────────────────────
  {
    const after = base();
    after.people.ana = { ...after.people.ana, presets: ["engineer", "lead"] };
    check("assigning a person a second preset requires exactly admin.people.assign",
      eq(changeClasses(base(), after), ["admin.people.assign"]), changeClasses(base(), after));
  }

  // ── person.grant/revoke/note: admin.people.override, alone ──────────
  {
    const after = base();
    after.people.ana = { ...after.people.ana, grant: ["deps.read", "aws.costs.read"] };
    check("granting a person something extra requires exactly admin.people.override",
      eq(changeClasses(base(), after), ["admin.people.override"]), changeClasses(base(), after));
  }
  {
    const after = base();
    after.people.ana = { ...after.people.ana, revoke: ["deps.age.read"] };
    check("revoking something from a person requires exactly admin.people.override",
      eq(changeClasses(base(), after), ["admin.people.override"]), changeClasses(base(), after));
  }
  {
    const after = base();
    after.people.ana = { ...after.people.ana, note: "moved teams" };
    check("a diff that only touches note requires exactly admin.people.override",
      eq(changeClasses(base(), after), ["admin.people.override"]), changeClasses(base(), after));
  }

  // ── a brand new person, an entry removed ─────────────────────────────
  {
    const after = base();
    after.people.ben = { presets: ["engineer"] };
    check("a new person entry with presets requires admin.people.assign",
      eq(changeClasses(base(), after), ["admin.people.assign"]), changeClasses(base(), after));
  }
  {
    const before = base();
    before.people.ben = { grant: ["overview.read"] };
    const after = base();
    check("removing a person entry that only held overrides requires admin.people.override",
      eq(changeClasses(before, after), ["admin.people.override"]), changeClasses(before, after));
  }

  // ── teams: admin.people.assign ───────────────────────────────────────
  {
    const after = base();
    after.teams = { platform: { presets: ["engineer", "lead"] } };
    check("a changed team's presets requires admin.people.assign",
      eq(changeClasses(base(), after), ["admin.people.assign"]), changeClasses(base(), after));
  }

  // ── presets: create, edit, delete, in isolation ──────────────────────
  {
    const after = base();
    after.presets = { ...after.presets, manager: { name: "Manager" } };
    check("a preset id that appears requires exactly admin.presets.create",
      eq(changeClasses(base(), after), ["admin.presets.create"]), changeClasses(base(), after));
  }
  {
    const after = base();
    delete after.presets.lead;
    check("a preset id that disappears requires exactly admin.presets.delete",
      eq(changeClasses(base(), after), ["admin.presets.delete"]), changeClasses(base(), after));
  }
  {
    const after = base();
    after.presets = { ...after.presets, engineer: { ...after.presets.engineer, grant: ["repos.read", "pulls.read"] } };
    check("changing an existing preset's grant requires exactly admin.presets.edit",
      eq(changeClasses(base(), after), ["admin.presets.edit"]), changeClasses(base(), after));
  }
  {
    const after = base();
    after.presets = { ...after.presets, engineer: { ...after.presets.engineer, inherits: "lead" } };
    check("changing an existing preset's inherits requires exactly admin.presets.edit",
      eq(changeClasses(base(), after), ["admin.presets.edit"]), changeClasses(base(), after));
  }

  // ── a rename is an edit, not a create+delete ─────────────────────────
  {
    const after = base();
    after.presets = { ...after.presets, engineer: { ...after.presets.engineer, name: "Software Engineer" } };
    check("renaming a preset (same id, new `name`) is an edit, not a create and a delete",
      eq(changeClasses(base(), after), ["admin.presets.edit"]), changeClasses(base(), after));
  }

  // ── the case the check exists for: never the most specific class alone ──
  {
    const after = base();
    after.people.ana = { ...after.people.ana, presets: ["engineer", "lead"] };
    after.presets = { ...after.presets, lead: { ...after.presets.lead, grant: ["pulls.mute", "pulls.pause"] } };
    check("assigning a preset and editing that preset in the same write requires both",
      eq(changeClasses(base(), after), ["admin.people.assign", "admin.presets.edit"]),
      changeClasses(base(), after));
  }

  // ── everything at once, nothing dropped ──────────────────────────────
  {
    const after = base();
    after.people.ana = { ...after.people.ana, presets: ["lead"], grant: ["deps.read"], note: "promoted" };
    after.people.ben = { presets: ["engineer"] };
    after.teams = { platform: { presets: ["lead"] } };
    after.presets = {
      engineer: after.presets.engineer,
      manager: { name: "Manager" },
    }; // lead deleted, manager created, engineer untouched
    const got = changeClasses(base(), after);
    check("every class present shows up at once, in one diff",
      eq(got, [
        "admin.people.assign", "admin.people.override",
        "admin.presets.create", "admin.presets.delete",
      ]), got);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
