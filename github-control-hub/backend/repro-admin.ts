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

console.log("the admin router: where each route's guard is named");
{
  check("it is mounted", /\/api\/admin/.test(server) && /adminRoutes/.test(server));

  check("  behind authentication", /app\.use\("\/api\/admin",\s*authMiddleware/.test(server));

  /**
   * The gate that decides something in the configuration this ships in is
   * asserted by **driving it** — see "the legacy team gate, run" below.
   *
   * It used to be asserted here, as
   * `admin.search(/router\.use\(\s*requireControlHubAdmin\s*\)/)` against this
   * file's text, positioned before the first route. Commenting the line out
   * left the whole suite passing: a commented-out gate still matches the
   * substring, and the substring was the whole assertion. That is precisely
   * the failure this file was rewritten to stop making, and it survived the
   * rewrite because it reads like a position check rather than a text scan.
   */

  /**
   * Reading the file means reading who holds what across the organization —
   * the same aggregation the access map is gated on. Writing it is the most
   * privileged act in the app.
   */
  {
    const at = admin.indexOf('router.get("/file"');
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check('  GET /file needs admin.people.read or admin.presets.read',
      at >= 0 && /requireAnyPermission\(/.test(line)
        && line.includes('"admin.people.read"') && line.includes('"admin.presets.read"'),
      line.trim());
  }

  for (const [path, permission] of [
    ['router.get("/vocabulary"', "admin.console.open"],
    ['router.get("/person/:login"', "admin.people.read"],
    ['router.get("/preset/:id/resolved"', "admin.presets.read"],
    ['router.get("/audit"', "admin.audit.read"],
    ['router.post("/bootstrap"', "admin.people.assign"],
    ['router.get("/dry-run"', "admin.people.read"],
    ['router.post("/migrate"', "admin.people.assign"],
  ] as const) {
    const at = admin.indexOf(path);
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check(`  ${path.slice(12)} needs ${permission}`,
      at >= 0 && line.includes(`requirePermission("${permission}")`), line.trim());
  }

  {
    const at = admin.indexOf('router.put(');
    const handlerAt = admin.indexOf("async (req: Request, res: Response) => {", at);
    const gate = at >= 0 && handlerAt > at ? admin.slice(at, handlerAt) : "";
    check('  PUT /file is gated on requireAnyPermission of all five admin write permissions',
      at >= 0 && /requireAnyPermission\(/.test(gate)
        && ["admin.people.assign", "admin.people.override", "admin.presets.create",
            "admin.presets.edit", "admin.presets.delete"].every(k => gate.includes(`"${k}"`)),
      gate.trim());
  }

  /**
   * Inspecting somebody else must not lend them the inspector's teams. Stage 2
   * shipped exactly that bug; the two-function split is what prevents it, and
   * this router is the caller that would reintroduce it.
   */
  check("inspecting another login uses the tokenless call",
    /accessForOther\(/.test(admin) && !/accessForSelf\([^)]*params/.test(admin),
    "accessForSelf with somebody else's login lends them your teams");
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
    { login: "aws-person", isControlHubAdmin: false, isAwsAdmin: true, isOrgOwner: false },
    { login: "everybody-else", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: false },
  ];

  // An empty file is what the flip would use if nobody ran the migration.
  const rows = dryRun(emptyFile(), members);
  check("with an empty file, everybody loses everything",
    rows.length === 3 && rows.every(r => r.losing.length > 0 && r.keeping === 0), rows);

  // With the starting file, nobody loses anything — that is the whole point.
  const safe = dryRun(startingFile(members), members);
  check("with the starting file, nobody loses anything",
    safe.every(r => r.losing.length === 0), safe.filter(r => r.losing.length));

  check("  and everybody keeps something", safe.every(r => r.keeping > 0));

  /**
   * The assertion above used to be vacuous, and this is what makes it mean
   * something.
   *
   * `dryRun` compared every person against a fixed `member` preset, so
   * `losing` could never name a leaf above plain-member level whatever the
   * file did — "nobody loses anything" was true by construction and would have
   * stayed true if `startingFile` dropped the two admin presets entirely.
   * `setup.md` makes that column the gate on the flip, so an empty column is
   * the sentence an operator acts on.
   *
   * Each case below is a real loss, taken against each person's *own* current
   * standing, and each must be reported.
   */
  {
    // 1. The exact mutation the old assertion could not see: the file keeps
    //    everybody, but the two admin presets are gone from it.
    const withoutAdminPresets = startingFile(members);
    delete withoutAdminPresets.presets["control-hub-admin"];
    delete withoutAdminPresets.presets["aws-admin"];
    for (const entry of Object.values(withoutAdminPresets.people)) entry.presets = ["member"];

    const stripped = dryRun(withoutAdminPresets, members);
    const admin = stripped.find(r => r.login === "an-admin")!;
    const aws = stripped.find(r => r.login === "aws-person")!;
    const plain = stripped.find(r => r.login === "everybody-else")!;

    check("a file that drops the admin presets reports the administrator losing what they hold",
      admin.losing.length > 0, admin);
    check("  and names the admin screens among the losses",
      admin.losing.includes("access.read") && admin.losing.includes("scanners.manage"), admin.losing);
    check("  and reports the AWS operator losing the AWS leaves",
      aws.losing.includes("aws.rules.edit") && aws.losing.includes("aws.remediate"), aws.losing);
    check("  while the plain member, whose standing did not change, loses nothing",
      plain.losing.length === 0, plain);

    /**
     * The direction that matters: everybody still holds *something* here, so a
     * `keeping` count alone reads as healthy. Only a per-person baseline can
     * tell the difference between "narrowed to member" and "unchanged".
     */
    check("  which a `keeping` count alone could not have told you",
      admin.keeping > 0 && aws.keeping > 0 && admin.keeping === plain.keeping,
      { admin: admin.keeping, aws: aws.keeping, plain: plain.keeping });
  }

  {
    // 2. One person narrowed, everybody else untouched. The row must be theirs
    //    alone — a baseline that over-reports would flag the whole organization
    //    and be read as noise.
    const narrowed = startingFile(members);
    narrowed.people["an-admin"] = { presets: ["member"] };

    const rows2 = dryRun(narrowed, members);
    const admin = rows2.find(r => r.login === "an-admin")!;
    check("narrowing one administrator reports that administrator, and only them",
      admin.losing.length > 0 && rows2.filter(r => r.losing.length > 0).length === 1,
      rows2.map(r => [r.login, r.losing.length]));
    check("  and the leaves named are the ones the admin preset was carrying",
      admin.losing.every(leaf => !dryRun(startingFile([members[2]]), [members[2]])[0]
        .losing.includes(leaf))
      && admin.losing.includes("admin.people.assign"),
      admin.losing);
  }

  {
    // 3. A revoke written at the person layer is a loss too, even though every
    //    preset assignment is untouched.
    const revoked = startingFile(members);
    revoked.people["aws-person"] = { presets: ["aws-admin"], revoke: ["aws.remediate"] };
    const aws = dryRun(revoked, members).find(r => r.login === "aws-person")!;
    check("a person-layer revoke is reported as a loss",
      aws.losing.length === 1 && aws.losing[0] === "aws.remediate", aws.losing);
  }

  check("an owner is reported as exempt rather than as losing nothing by luck",
    dryRun(emptyFile(), [{ login: "o", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: true }])[0]
      .isOrgOwner === true);

  /**
   * `startingFile` handing out the module-level `PRESETS` object itself was
   * harmless while the only consumer stringified it; `dryRun` now builds one
   * starting file per member, so a shared reference would be handed out once
   * per person per dry-run. `emptyFile()`'s docblock states the rule: a fresh
   * object per call cannot be poisoned.
   */
  {
    const a = startingFile([]);
    const b = startingFile([]);
    check("two starting files do not share their presets",
      a.presets !== b.presets && a.presets.member !== b.presets.member);
    a.presets.member.grant!.push("admin");
    check("  so widening one cannot widen the next",
      !(b.presets.member.grant ?? []).includes("admin"), b.presets.member.grant);
    check("  nor the third",
      !(startingFile([]).presets.member.grant ?? []).includes("admin"));
  }
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

  // ── ids that are also Object.prototype members ──────────────────────
  /**
   * `beforePresets[id]` was a plain bracket read on a `JSON.parse`d object, so
   * an id like `constructor` or `toString` resolved to an inherited
   * `Object.prototype` member instead of `undefined`. `!b && a` and `b && !a`
   * were then never true for it: creating *and* deleting such a preset both
   * classified as `admin.presets.edit`, so `admin.presets.edit` alone was
   * enough to create presets and to delete them — two of the three authorities
   * this module exists to keep apart — by choosing the id.
   *
   * Round-tripped through `JSON.stringify`/`JSON.parse` exactly as `store.ts`
   * produces it, since that is what makes `__proto__` an own property and is
   * the shape the bug needed.
   */
  {
    const roundTrip = (f: PermissionsFile): PermissionsFile => JSON.parse(JSON.stringify(f));

    /**
     * `table[id] = value` cannot express `__proto__`: the assignment hits
     * `Object.prototype`'s setter and sets the prototype instead of creating a
     * property. `JSON.parse` creates it as an own data property, which is what
     * `store.ts` hands the engine, and `defineProperty` is the same thing said
     * in one line for every id at once.
     */
    const put = (table: object, id: string, value: unknown) =>
      Object.defineProperty(table, id, { value, writable: true, enumerable: true, configurable: true });

    for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty",
                      "isPrototypeOf", "propertyIsEnumerable", "__proto__"]) {
      const before = roundTrip(base());
      const after = roundTrip(base());
      put(after.presets, id, { name: "Sneaky", grant: ["admin"] });

      check(`  the id really is an own property, the way JSON.parse makes one`,
        Object.keys(after.presets).includes(id) && Object.hasOwn(after.presets, id),
        Object.keys(after.presets));

      check(`creating a preset called "${id}" requires admin.presets.create`,
        eq(changeClasses(before, after), ["admin.presets.create"]), changeClasses(before, after));

      check(`  and deleting it requires admin.presets.delete`,
        eq(changeClasses(after, before), ["admin.presets.delete"]), changeClasses(after, before));

      const edited = roundTrip(after);
      put(edited.presets, id, { name: "Sneaky", grant: ["admin", "aws"] });
      check(`  and editing it requires admin.presets.edit`,
        eq(changeClasses(after, edited), ["admin.presets.edit"]), changeClasses(after, edited));
    }

    // The same family in `people` and `teams`: an entry keyed `constructor`
    // must be a real entry appearing, not an inherited function being read.
    {
      const before = roundTrip(base());
      const after = roundTrip(base());
      put(after.people, "constructor", { presets: ["engineer"] });
      check("a person entry keyed `constructor` is seen as an entry",
        eq(changeClasses(before, after), ["admin.people.assign"]), changeClasses(before, after));

      const teamAfter = roundTrip(base());
      put(teamAfter.teams, "toString", { presets: ["engineer"] });
      check("  as is a team entry keyed `toString`",
        eq(changeClasses(base(), teamAfter), ["admin.people.assign"]), changeClasses(base(), teamAfter));
    }

    /**
     * And the validator must not read a preset that does not exist as one that
     * does: `presets["toString"]` is a function on any parsed object, so an
     * entry assigned to it passed as valid and then resolved to nothing.
     */
    {
      const f = roundTrip(base());
      put(f.people, "mallory", { presets: ["toString"] });
      const problems = fileProblems(f);
      check("assigning a preset named after a prototype member is a file problem",
        problems.some(p => p.where === "people.mallory" && /does not exist/.test(p.what)), problems);

      const held = permissionsFor(f, { login: "mallory", teamSlugs: [], isOrgOwner: false });
      check("  and grants nothing in the meantime", held.held.length === 0, held.held);
    }
  }

  // ── the fields that used to cost nothing to change ──────────────────
  {
    const after = base();
    after.people.ana = { ...after.people.ana, id: 4242 };
    check("adding or changing a person's GitHub id requires admin.people.override",
      eq(changeClasses(base(), after), ["admin.people.override"]), changeClasses(base(), after));

    const bumped = { ...base(), version: 2 };
    check("a version bump reinterprets every section, so it asks for all five",
      changeClasses(base(), bumped).length === 5, changeClasses(base(), bumped));
  }

  // ── a people key that never evaluates ────────────────────────────────
  {
    /**
     * `collectRules` looks a person up by `login.toLowerCase()`, so `people.ANA`
     * is never consulted — and a **revoke** written there does nothing while
     * reading as though it had taken effect.
     */
    const f = base();
    Object.defineProperty(f.people, "ANA",
      { value: { revoke: ["repos.read"] }, writable: true, enumerable: true, configurable: true });
    const problems = fileProblems(f);
    check("a mixed-case people key is a file problem, not a silent no-op",
      problems.some(p => p.where === "people.ANA"), problems);

    const held = permissionsFor(f, { login: "ana", teamSlugs: [], isOrgOwner: false });
    check("  which matters because the revoke under it does nothing",
      held.has("repos.read"), held.held);
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

console.log("\npreset ids are read as own properties, never through the prototype");
{
  /**
   * The third site of the `Object.hasOwn` fix — `presets.ts`'s `own()`, used by
   * the chain walk, the `finish` reducer and `presetProblems` — had no
   * assertion anywhere. Reverting it to `presets[id]` left every suite in the
   * repository green, which is the same standard M7 was raised about: a fix
   * nothing pins is a fix the next refactor deletes.
   *
   * What it is for: `presets["constructor"]` on a `JSON.parse`d object is
   * `Object` — a function, and truthy — so a preset that inherits from a name
   * nobody defined resolved as though the parent existed. The chain then
   * silently grants nothing, and the file reports itself clean, which is the
   * worst combination available: an administrator sees a preset assigned and
   * a person who holds none of it, with nothing anywhere saying why.
   */
  const { resolvePreset, presetProblems } = require("./src/permissions/presets");

  // Parsed, not written as a literal: this is how the file actually arrives,
  // and the prototype members below are exactly the ones it does *not* carry.
  const presets = JSON.parse(JSON.stringify({
    real: { name: "Real", grant: ["repos.read"] },
    borrowed: { name: "Borrowed", inherits: "toString" },
  }));

  for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty",
                    "isPrototypeOf", "propertyIsEnumerable"]) {
    check(`  "${id}" is not a preset, however truthy the prototype makes it`,
      resolvePreset(presets, id, "preset").length === 0, resolvePreset(presets, id, "preset"));
  }

  const problems = presetProblems(presets);
  check("a preset inheriting from a prototype member is reported as dangling",
    problems.some((m: string) => m.includes('"borrowed"') && m.includes("does not exist")), problems);

  check("  which matters because the chain grants nothing either way",
    resolvePreset(presets, "borrowed", "preset").length === 0,
    resolvePreset(presets, "borrowed", "preset"));

  check("  while a real preset still resolves",
    resolvePreset(presets, "real", "preset").map((r: any) => r.node).join() === "repos.read",
    resolvePreset(presets, "real", "preset"));

  /**
   * And an id the file genuinely carries is still found, even when it collides
   * with something on the prototype. `JSON.parse` makes `__proto__` an own
   * property, so an own-property read has to keep answering with it.
   */
  const shadowing = JSON.parse('{"__proto__":{"name":"Shadow","grant":["pulls.read"]}}');
  check("a preset the file really names is found even when the prototype has the name too",
    resolvePreset(shadowing, "__proto__", "preset").map((r: any) => r.node).join() === "pulls.read",
    resolvePreset(shadowing, "__proto__", "preset"));
}

/**
 * ── the admin router, driven ────────────────────────────────────────────
 *
 * Everything above this line reads source text. That is fine for "which
 * permission does this line name", and useless for anything else: the previous
 * version of this file asserted "migrate refuses to regenerate over a file
 * that already has people in it" as `/migrate/ && /409/ && /people/` — three
 * unrelated substrings over a 368-line file — and deleting the entire 409 guard
 * left it passing, along with "saving sends the sha the editor loaded" and "an
 * invalid file is refused with its problems named".
 *
 * **An assertion that passes when the behaviour it names is deleted is worse
 * than no assertion**, because it is a claim the next reviewer will trust.
 *
 * So the handlers are run. `permissions/testing.ts` supplies the stored file,
 * the caller's teams and their ownership; `initTokenManager`'s injection seam
 * supplies a token; `globalThis.fetch` is stubbed so GitHub's contents API can
 * answer, and so the outgoing write can be read back. Nothing here reaches the
 * network, and nothing here is a substring scan.
 */
async function theAdminRouterDriven() {
  const { setPermissionsTestHooks } = require("./src/permissions/testing");
  const { forgetPermissions } = require("./src/permissions/store");
  const { forgetSubjects } = require("./src/permissions/subject");
  const client = require("./src/github/client");
  const adminRouter = require("./src/routes/admin").default;

  const flagBefore = process.env.PERMISSIONS_ENABLED;
  const orgBefore = process.env.GITHUB_ORG;
  const realFetch = globalThis.fetch;

  /**
   * On, for this file only and restored below.
   *
   * The enforcement path is what these tests are about, and it is `return
   * next()` with the flag unset. Nothing about the shipped configuration
   * changes: `PERMISSIONS_ENABLED` is read from the environment at every call,
   * this process sets it for its own handlers and puts it back, and
   * `repro-undo.ts` asserts the *unset* behaviour of the same routes.
   */
  process.env.PERMISSIONS_ENABLED = "true";
  process.env.GITHUB_ORG = process.env.GITHUB_ORG || "acme";

  await client.initTokenManager("1", "a-key", "2",
    () => async () => ({ token: "app-token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));

  /** Every request GitHub's contents API was asked to make, newest last. */
  let writes: Array<{ method: string; sha: unknown; body: any }> = [];
  /** What the next write should be answered with. */
  let writeAnswer: { status: number; body: any } = { status: 200, body: { content: { sha: "written-sha" } } };

  /**
   * The organization GitHub reports, for the one route that asks: `POST
   * /migrate` reads every member, every owner and both legacy teams before it
   * writes anything. Null unless a test sets it, so every other test sees the
   * stub exactly as it was.
   */
  let orgSnapshot: { members: string[]; owners: string[]; teams: Record<string, string[]> } | null = null;

  (globalThis as any).fetch = async (url: any, init: any) => {
    const u = String(url);
    const parsed = init?.body ? JSON.parse(init.body) : {};
    writes.push({ method: init?.method ?? "GET", sha: parsed.sha, body: parsed });

    if (orgSnapshot && (init?.method ?? "GET") === "GET") {
      const page = Number(new URL(u, "https://api.github.com").searchParams.get("page") ?? "1");
      const asUsers = (logins: string[]) => (page > 1 ? [] : logins.map(login => ({ login, type: "User" })));
      // `/memberships/<login>` deliberately does not match either of these:
      // those are the single-person checks the team gate makes.
      const team = u.match(/\/teams\/([^/]+)\/members(?:\?|$)/);
      const list =
        team ? asUsers(orgSnapshot.teams[team[1]] ?? [])
        : /\/orgs\/[^/]+\/members(?:\?|$)/.test(u)
          ? asUsers(/role=admin/.test(u) ? orgSnapshot.owners : orgSnapshot.members)
        : null;
      if (list) {
        return new Response(JSON.stringify(list), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify(writeAnswer.body), {
      status: writeAnswer.status,
      headers: { "content-type": "application/json" },
    });
  };

  /** One route's handler — the last thing in its stack, past every guard. */
  const handlerFor = (method: string, path: string) => {
    for (const layer of adminRouter.stack) {
      if (!layer.route || layer.route.path !== path) continue;
      if (!layer.route.methods[method]) continue;
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    throw new Error(`no ${method.toUpperCase()} ${path} on the admin router`);
  };

  interface Answer { status: number; body: any }

  /**
   * Run one handler and read the answer off the fake response.
   *
   * Bounded, so that a regression reads as a failed assertion rather than as a
   * suite that never finishes: a handler that neither answers nor throws is
   * itself the bug being looked for.
   */
  const answerOf = (handler: any, req: any): Promise<Answer> => new Promise<Answer>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: 0, body: { error: "the handler never answered" } }), 10_000);
    const settle = (a: Answer) => { clearTimeout(timer); resolve(a); };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { settle({ status: this.statusCode, body }); return this; },
    };
    Promise.resolve(handler(req, res, () => {})).catch((err: any) => { clearTimeout(timer); reject(err); });
  });

  /**
   * Put a stored file in place and run one handler against it.
   *
   * `stored` is what `loadPermissions` will return — or a `LoadFailure`, which
   * is how the fail-closed case below is reached.
   */
  const run = async (
    method: string, path: string,
    opts: { stored: any; as: string; owner?: boolean; teams?: string[]; body?: any; params?: any },
  ): Promise<Answer> => {
    setPermissionsTestHooks({
      loadFile: () => opts.stored,
      ownTeams: () => opts.teams ?? [],
      teamsOf: () => opts.teams ?? [],
      ownerOf: () => opts.owner === true,
    });
    forgetPermissions();
    forgetSubjects();
    writes = [];

    return await answerOf(handlerFor(method, path), {
      user: { login: opts.as, accessToken: `${opts.as}-token` },
      params: opts.params ?? {}, query: {}, body: opts.body ?? {},
    });
  };

  const loaded = (file: PermissionsFile, sha: string | null = "stored-sha") =>
    ({ file, sha, source: "github" as const });

  // Somebody holding exactly one admin write permission, and the preset that
  // this branch's own migration writes into every organization on day one.
  const withCaller = (grant: string[], extra: Partial<PermissionsFile> = {}): PermissionsFile => ({
    version: 1,
    presets: {
      member: { name: "Member", grant: ["me", "overview.read"] },
      "control-hub-admin": {
        name: "Control Hub Admin", inherits: "member",
        grant: ["alarms", "scanners", "widgets", "access", "config", "activity", "pulls", "deps", "repos", "admin"],
      },
      ...(extra.presets ?? {}),
    },
    teams: extra.teams ?? {},
    people: { plain: { presets: ["member"], grant }, ...(extra.people ?? {}) },
  });

  /**
   * Drive one route's whole middleware chain — the router-level `use` gates in
   * front of the per-route ones — and report what it decided. "passed" means
   * the chain called `next()` off its end, so the handler would have run.
   */
  type Decision = { kind: "passed" } | { kind: "refused"; status: number; code?: string };

  const runChain = (chain: any[], req: any): Promise<Decision> => new Promise(resolve => {
    let done = false;
    const settle = (d: Decision) => { if (!done) { done = true; resolve(d); } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { settle({ kind: "refused", status: this.statusCode, code: body?.code }); return this; },
      send() { return this.json({}); },
      end() { return this.json({}); },
    };
    let i = 0;
    const next = () => {
      if (done) return;
      if (i >= chain.length) return settle({ kind: "passed" });
      const mw = chain[i++];
      try {
        const out = mw(req, res, next);
        if (out && typeof out.catch === "function") out.catch(() => settle({ kind: "passed" }));
      } catch { settle({ kind: "passed" }); }
    };
    next();
    setTimeout(() => settle({ kind: "passed" }), 5_000).unref?.();
  });

  /** Every route's guards, in the order express would run them. */
  const guardChains = (): Array<{ what: string; chain: any[] }> => {
    const blanket = adminRouter.stack.filter((l: any) => !l.route).map((l: any) => l.handle);
    return adminRouter.stack.filter((l: any) => l.route).map((layer: any) => ({
      what: `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`,
      chain: [...blanket, ...layer.route.stack.map((h: any) => h.handle).slice(0, -1)],
    }));
  };

  try {
    console.log("\nthe legacy team gate, run");
    {
      /**
       * **Driven, not scanned.** This assertion used to be a search for
       * `router.use(requireControlHubAdmin)` in this file's own text, and
       * commenting that line out left the suite entirely green — a commented
       * gate matches the substring just as well as a live one.
       *
       * So the real chains are run, with `PERMISSIONS_ENABLED` in the state it
       * ships in. That is deliberate and it is the whole point: with the flag
       * unset every `requirePermission` is `return next()`, so the team gate is
       * the only thing left that can refuse anybody, and a route that reaches
       * its handler here is a route open to every signed-in member.
       */
      const flagHere = process.env.PERMISSIONS_ENABLED;
      delete process.env.PERMISSIONS_ENABLED;
      const { invalidateAdminCache } = require("./src/services/authorizationService");
      try {
        // GitHub answers "not a member of anything" — the object the stub
        // returns has neither `role: "admin"` nor `state: "active"`.
        invalidateAdminCache();
        const refusals = [];
        for (const { what, chain } of guardChains()) {
          refusals.push({ what, d: await runChain(chain, {
            user: { login: "on-no-team", accessToken: "on-no-team-token" },
            params: {}, query: {}, body: {},
          }) });
        }
        const open = refusals.filter(r => r.d.kind === "passed").map(r => r.what);
        check("with the flag unset, every route refuses somebody not on control-hub-admins",
          refusals.length >= 9 && open.length === 0, { routes: refusals.length, open });
        check("  and says which team would let them in, rather than reading as an outage",
          refusals.every(r => r.d.kind === "refused" && r.d.status === 403
            && r.d.code === "CONTROL_HUB_ADMIN_REQUIRED"),
          refusals.map(r => r.d));

        /**
         * And it is a *gate*, not a wall: the premise is that a member of the
         * team gets past it. Without this the assertion above would pass on a
         * router that refused everybody, which is a different bug.
         */
        invalidateAdminCache();
        writeAnswer = { status: 200, body: { state: "active" } };
        const member = await runChain(guardChains()[0].chain, {
          user: { login: "a-real-admin", accessToken: "a-real-admin-token" },
          params: {}, query: {}, body: {},
        });
        writeAnswer = { status: 200, body: { content: { sha: "written-sha" } } };
        check("  while a member of that team gets through it",
          member.kind === "passed", member);
      } finally {
        invalidateAdminCache();
        if (flagHere === undefined) delete process.env.PERMISSIONS_ENABLED;
        else process.env.PERMISSIONS_ENABLED = flagHere;
      }
    }

    console.log("\nPUT /file: the diff decides, against the file that is really stored");
    {
      const stored = withCaller(["admin.people.assign"]);

      // A write this caller's one permission does not cover.
      const editsAPreset = JSON.parse(JSON.stringify(stored));
      editsAPreset.presets.member.grant.push("repos.read");
      const refused = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: editsAPreset, sha: "stored-sha", summary: "edit a preset" },
      });
      check("a preset edit by somebody holding only admin.people.assign is refused",
        refused.status === 403 && refused.body.code === "PERMISSION_REQUIRED"
          && refused.body.permission === "admin.presets.edit", refused);
      check("  and nothing was written", writes.length === 0, writes);

      // A write it does cover, on somebody else.
      const assignsSomebodyElse = JSON.parse(JSON.stringify(stored));
      assignsSomebodyElse.people.dana = { presets: ["member"] };
      const allowed = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: assignsSomebodyElse, sha: "stored-sha", summary: "assign dana the member preset" },
      });
      check("assigning somebody else a preset they may assign goes through",
        allowed.status === 200 && allowed.body.ok === true, allowed);

      /**
       * The sha the editor loaded reaches GitHub. Without it the contents API
       * accepts the write unconditionally and the second of two administrators
       * on the same screen silently discards the first one's work.
       */
      check("  and the write carried the sha the editor loaded",
        writes.length === 1 && writes[0].method === "PUT" && writes[0].sha === "stored-sha", writes);
    }

    console.log("\nPUT /file: a conflict is a conflict, and a broken file names its problems");
    {
      const stored = withCaller(["admin.people.assign"]);
      const after = JSON.parse(JSON.stringify(stored));
      after.people.dana = { presets: ["member"] };

      writeAnswer = { status: 409, body: { message: "sha did not match" } };
      const conflict = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: after, sha: "a-stale-sha", summary: "assign dana" },
      });
      writeAnswer = { status: 200, body: { content: { sha: "written-sha" } } };
      check("GitHub rejecting a stale sha is reported as a conflict, not as a failure",
        conflict.status === 409 && conflict.body.code === "conflict", conflict);

      // A file naming a preset that does not exist means something other than
      // what it says, so it is refused before it can be written.
      const broken = JSON.parse(JSON.stringify(stored));
      broken.people.dana = { presets: ["does-not-exist"] };
      const invalid = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: broken, sha: "stored-sha", summary: "assign dana" },
      });
      check("an invalid file is refused with its problems named, not with a bare rejection",
        invalid.status === 400 && Array.isArray(invalid.body.problems)
          && invalid.body.problems.some((p: any) => p.where === "people.dana"), invalid);
      check("  and nothing reached GitHub", writes.length === 0, writes);
    }

    console.log("\nPUT /file: no write may widen the writer");
    {
      /**
       * The escalation this branch shipped: `plain` holds exactly
       * `admin.people.assign`, adds the `control-hub-admin` preset — which
       * grants the whole `admin` branch — to their own entry, and
       * `changeClasses` says `["admin.people.assign"]`, so it was permitted.
       * Afterwards they held all five admin write permissions. The five-way
       * split is this stage's headline deliverable and this collapsed it back
       * into one.
       */
      const stored = withCaller(["admin.people.assign"]);
      const selfPromote = JSON.parse(JSON.stringify(stored));
      selfPromote.people.plain.presets = ["member", "control-hub-admin"];

      const before = permissionsFor(stored, { login: "plain", teamSlugs: [], isOrgOwner: false });
      const after = permissionsFor(selfPromote, { login: "plain", teamSlugs: [], isOrgOwner: false });
      check("the escalation is real: the write would hand the writer the other four",
        !before.has("admin.presets.edit") && after.has("admin.presets.edit")
          && after.has("admin.people.override") && after.has("admin.presets.delete"),
        { before: before.held.length, after: after.held.length });
      check("  and changeClasses alone cannot see it — the diff really is one assignment",
        changeClasses(stored, selfPromote).join() === "admin.people.assign",
        changeClasses(stored, selfPromote));

      const refused = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: selfPromote, sha: "stored-sha", summary: "make myself an admin" },
      });
      check("so the handler refuses it",
        refused.status === 403 && refused.body.code === "SELF_WIDENING", refused);
      check("  and says what would have been gained, rather than a bare refusal",
        Array.isArray(refused.body.gained)
          && refused.body.gained.includes("admin.presets.edit")
          && refused.body.gained.includes("admin.people.override")
          && /would give you permissions you do not hold/.test(String(refused.body.error))
          && refused.body.gained.some((k: string) => String(refused.body.error).includes(k)),
        { gained: refused.body.gained?.length, error: refused.body.error });
      check("  and nothing was written", writes.length === 0, writes);

      /**
       * The symmetric path: edit a preset you already hold to add `grant:
       * ["admin"]`. `changeClasses` returns exactly `admin.presets.edit`, which
       * this caller has.
       */
      const editor = withCaller(["admin.presets.edit"]);
      const widenedPreset = JSON.parse(JSON.stringify(editor));
      widenedPreset.presets.member.grant.push("admin");
      check("editing a preset you hold to grant yourself `admin` classifies as a plain edit",
        changeClasses(editor, widenedPreset).join() === "admin.presets.edit",
        changeClasses(editor, widenedPreset));
      const refusedPreset = await run("put", "/file", {
        stored: loaded(editor), as: "plain",
        body: { file: widenedPreset, sha: "stored-sha", summary: "tweak member" },
      });
      check("  and is refused the same way",
        refusedPreset.status === 403 && refusedPreset.body.code === "SELF_WIDENING", refusedPreset);

      /**
       * The rule is "no wider", not "no self-edit": narrowing yourself is
       * exactly what an administrator handing over should be able to do, and a
       * blanket "you may not touch your own entry" would forbid it.
       */
      const holdsEverything = withCaller([], {
        people: { plain: { presets: ["control-hub-admin"] } },
      });
      const narrowed = JSON.parse(JSON.stringify(holdsEverything));
      narrowed.people.plain = { presets: ["member"] };
      const allowed = await run("put", "/file", {
        stored: loaded(holdsEverything), as: "plain",
        body: { file: narrowed, sha: "stored-sha", summary: "hand over" },
      });
      check("narrowing yourself is still allowed", allowed.status === 200 && allowed.body.ok === true, allowed);

      // And editing a preset you hold in a way that does not widen you.
      const renamed = JSON.parse(JSON.stringify(holdsEverything));
      renamed.presets.member.name = "Everybody";
      const rename = await run("put", "/file", {
        stored: loaded(holdsEverything), as: "plain",
        body: { file: renamed, sha: "stored-sha", summary: "rename member" },
      });
      check("  as is editing a preset you hold without widening yourself",
        rename.status === 200 && rename.body.ok === true, rename);

      /**
       * Organization owners are exempt everywhere else here — they already hold
       * everything, so there is nothing to widen into — and pretending
       * otherwise would refuse them a write that changes nothing about them.
       */
      const owner = await run("put", "/file", {
        stored: loaded(stored), as: "plain", owner: true,
        body: { file: selfPromote, sha: "stored-sha", summary: "the same write, as an owner" },
      });
      check("an organization owner is exempt", owner.status === 200 && owner.body.ok === true, owner);
    }

    console.log("\nPUT /file: an unreadable store fails closed");
    {
      /**
       * The "before" used to fall back to `emptyFile()` when the store could
       * not be read, so the diff ran against nothing: a submission wiping every
       * preset and person requires `["admin.people.assign",
       * "admin.presets.delete"]` against the stored file and `[]` against an
       * empty one. `[]` skips the 403 and the wipe is written — and
       * deny-by-default then means the organization has just locked itself out.
       */
      const stored = withCaller(["admin.people.assign"], {
        presets: { engineer: { name: "Engineer", grant: ["repos.read"] } },
      });
      const wipe: PermissionsFile = { version: 1, presets: {}, teams: {}, people: {} };

      check("the wipe really does require a permission this caller lacks",
        changeClasses(stored, wipe).includes("admin.presets.delete"), changeClasses(stored, wipe));
      check("  which diffing against an empty file would not ask for at all",
        changeClasses(emptyFile(), wipe).length === 0, changeClasses(emptyFile(), wipe));

      /**
       * Reaching the fallback means reaching the one window it lives in: the
       * handler reads the file twice — once through `accessForSelf`, once to
       * diff against — and the failure has to land on the *second* read, or the
       * `access.failure` check above it answers 503 first and nothing below
       * runs. `store.ts` caches for a minute, so the window is that cache
       * expiring between the two calls with GitHub failing on the re-read.
       *
       * A clock that jumps a minute on every reading opens it deterministically:
       * every cache in the process misses, the hook is asked twice, and it
       * answers with the stored file first and an outage second.
       */
      const realNow = Date.now;
      let reads = 0;
      try {
        let t = realNow.call(Date);
        Date.now = () => { t += 61_000; return t; };

        setPermissionsTestHooks({
          loadFile: () => (++reads === 1
            ? loaded(stored)
            : { reason: "unreachable", detail: "GitHub is not answering" }),
          ownTeams: () => [],
          teamsOf: () => [],
          ownerOf: () => false,
        });
        forgetPermissions();
        forgetSubjects();
        writes = [];

        const answer = await answerOf(handlerFor("put", "/file"), {
          user: { login: "plain", accessToken: "plain-token" }, params: {}, query: {},
          body: { file: wipe, sha: "stored-sha", summary: "wipe it" },
        });

        check("the window really did open: the caller was resolved, then the re-read failed",
          reads >= 2, reads);
        check("a store that cannot be re-read answers 503, the same as the gate above it",
          answer.status === 503 && answer.body.code === "PERMISSIONS_UNAVAILABLE", answer);
        check("  and nothing is written against an empty baseline",
          writes.length === 0, writes);
      } finally {
        Date.now = realNow;
      }
    }

    console.log("\nGET /file: a section you may not read does not cross the wire");
    {
      /**
       * `GET /file` is reachable with either read permission, because People
       * and Presets render from one file — and it answered with the whole of
       * it, so a holder of `admin.presets.read` alone received every person's
       * grants, revokes and free-text notes. Hiding the People *tab* client-side
       * is not the same thing: the data was already in the browser.
       */
      const stored = withCaller(["admin.presets.read", "admin.presets.edit"], {
        people: {
          dana: { presets: ["control-hub-admin"], revoke: ["aws"], note: "left the platform team in March" },
        },
      });

      const presetsOnly = await run("get", "/file", { stored: loaded(stored), as: "plain" });
      check("a presets-only reader gets the presets",
        presetsOnly.status === 200 && !!presetsOnly.body.file.presets["control-hub-admin"], presetsOnly.body.file);
      check("  and no people table at all — absent, not empty",
        presetsOnly.body.file.people === undefined
          && !JSON.stringify(presetsOnly.body).includes("left the platform team"),
        Object.keys(presetsOnly.body.file));
      check("  and is told which section was withheld rather than left to read it as nobody",
        Array.isArray(presetsOnly.body.withheld) && presetsOnly.body.withheld.includes("people"),
        presetsOnly.body.withheld);

      const storedBoth = withCaller(["admin.presets.read", "admin.people.read"], {
        people: { dana: { presets: ["member"], note: "a note" } },
      });
      const bothReads = await run("get", "/file", { stored: loaded(storedBoth), as: "plain" });
      check("somebody holding both reads still gets both",
        bothReads.body.file.people?.dana?.note === "a note"
          && !!bothReads.body.file.presets.member && bothReads.body.withheld === undefined,
        bothReads.body.withheld);

      const peopleOnly = await run("get", "/file", {
        stored: loaded(withCaller(["admin.people.read"], { people: { dana: { presets: ["member"] } } })),
        as: "plain",
      });
      check("and the presets go the same way for a people-only reader",
        peopleOnly.body.file.presets === undefined && !!peopleOnly.body.file.people,
        Object.keys(peopleOnly.body.file));

      /**
       * The other half of withholding a section: the screen submits the file it
       * was given, so taking that at face value would delete every person in
       * the organization on the next preset edit. The stored section is put
       * back before anything is diffed or saved.
       */
      const submitted = JSON.parse(JSON.stringify(presetsOnly.body.file));
      submitted.presets.member.description = "everybody";
      const saved = await run("put", "/file", {
        stored: loaded(stored), as: "plain",
        body: { file: submitted, sha: "stored-sha", summary: "describe member" },
      });
      check("saving a file with a withheld section put back does not delete that section",
        saved.status === 200 && !!writes[0]?.body?.content, saved);
      const written = JSON.parse(Buffer.from(writes[0].body.content, "base64").toString("utf8"));
      check("  the people table is written back exactly as it was stored",
        written.people?.dana?.note === "left the platform team in March", written.people);
    }

    console.log("\nwith PERMISSIONS_ENABLED unset, none of the above happens");
    {
      /**
       * The inertness rule, checked rather than assumed. Everything this branch
       * added to these two handlers sits behind `PERMISSIONS_ENABLED()`, so
       * with the flag in the state it ships in the router answers exactly what
       * it answered before — the one change being the team gate in front of it,
       * which `repro-undo.ts` drives.
       */
      process.env.PERMISSIONS_ENABLED = "false";
      try {
        const stored = withCaller(["admin.presets.read"], {
          people: { dana: { presets: ["member"], note: "a note" } },
        });

        const whole = await run("get", "/file", { stored: loaded(stored), as: "plain" });
        check("GET /file withholds nothing, however little the caller holds",
          !!whole.body.file.people?.dana && !!whole.body.file.presets?.member
            && whole.body.withheld === undefined,
          { keys: Object.keys(whole.body.file), withheld: whole.body.withheld });

        /**
         * And the write path decides nothing either — not `changeClasses`, not
         * the self-widening rule — which is what it did before this branch. The
         * team gate is the authorization in this configuration.
         */
        const selfPromote = JSON.parse(JSON.stringify(stored));
        selfPromote.people.plain.presets = ["member", "control-hub-admin"];
        const write = await run("put", "/file", {
          stored: loaded(stored), as: "plain",
          body: { file: selfPromote, sha: "stored-sha", summary: "unchecked, as before" },
        });
        check("  and PUT /file applies no permission check of its own",
          write.status === 200 && write.body.ok === true, write);

        /**
         * `writeFile` is the one write path now, so its inertness is the
         * inertness of all three. `POST /migrate` over an empty file, by a
         * caller who is nobody under the file and not an organization owner,
         * writes the starting file exactly as it did before — the
         * self-widening rule it would fail with the flag on decides nothing
         * here.
         */
        orgSnapshot = {
          members: ["plain", "other"], owners: [],
          teams: { "control-hub-admins": ["plain"], "aws-guardrail-admins": [] },
        };
        try {
          const migrated = await run("post", "/migrate", {
            stored: loaded({ version: 1, presets: {}, teams: {}, people: {} }), as: "plain",
          });
          check("  and POST /migrate writes the starting file with no self-widening check",
            migrated.status === 200 && migrated.body.ok === true, migrated);

          /**
           * The complete list of what this branch changes with the flag unset.
           * Three things, all inside the Admin tab, none of them a loss:
           *
           * 1. Every route requires `control-hub-admins` membership. Without
           *    this the permission gate is `return next()` and the tab is live
           *    for every signed-in member.
           * 2. `/migrate` refuses a file it would have overwritten — a refusal
           *    rather than a loss, the same caveat the `presets` half of this
           *    guard already carried.
           * 3. `/bootstrap` answers 409 on a save conflict where it answered
           *    502, because it now shares `writeFile`'s status mapping. 409 is
           *    the correct answer for a conflict and 502 was wrong, so this is
           *    listed rather than reverted — but it is listed, because "the
           *    flag changes nothing" is a claim that has to be exhaustive to
           *    be worth making.
           */
          const teamsOnly = await run("post", "/migrate", {
            stored: loaded({ version: 1, presets: {}, people: {},
              teams: { platform: { grant: ["admin.people.assign"] } } }),
            as: "plain",
          });
          check("  while a file it would have destroyed is still refused, flag or no flag",
            teamsOnly.status === 409 && writes.filter(w => w.method === "PUT").length === 0, teamsOnly);
        } finally {
          orgSnapshot = null;
        }

        /**
         * And the person route's new fields are additive: they decide nothing,
         * here or anywhere, and the answer it gave before is still in it.
         */
        const person = await run("get", "/person/:login", {
          stored: loaded(stored), as: "plain", params: { login: "dana" },
        });
        check("  and GET /person/:login still answers what it answered before",
          person.status === 200 && Array.isArray(person.body.held)
            && !!person.body.explanations && !!person.body.baseline, person.status);
      } finally {
        process.env.PERMISSIONS_ENABLED = "true";
      }
    }

    console.log("\nPUT /file: a caller whose own standing cannot be established");
    {
      /**
       * `subjectFor` catches a failed team listing, logs it, and answers with
       * `teamSlugs: []`. The self-widening check then computed **both** sides
       * against a teamless subject, so a write handing `admin` to a team the
       * caller is in registered as no gain at all and went through.
       *
       * The precondition is only a transient failure on `GET /user/teams` —
       * the same class of window the unreadable-store check above was fixed
       * for, and it was failing the other way: that one answers 503 when its
       * input is missing, this one carried on as though the answer were
       * "none".
       */
      const stored = withCaller(["admin.people.assign"]);
      const widen = JSON.parse(JSON.stringify(stored));
      widen.teams = { platform: { presets: ["control-hub-admin"] } };

      const inTeam = { login: "plain", teamSlugs: ["platform"], isOrgOwner: false };
      check("the escalation is real: granting a team you are in the admin preset widens you",
        !permissionsFor(stored, inTeam).has("admin.presets.delete")
          && permissionsFor(widen, inTeam).has("admin.presets.delete"),
        { before: permissionsFor(stored, inTeam).held.length,
          after: permissionsFor(widen, inTeam).held.length });

      const readable = await run("put", "/file", {
        stored: loaded(stored), as: "plain", teams: ["platform"],
        body: { file: widen, sha: "stored-sha", summary: "widen my own team" },
      });
      check("  with the caller's teams readable it is refused",
        readable.status === 403 && readable.body.code === "SELF_WIDENING"
          && (readable.body.gained ?? []).includes("admin.presets.delete"), readable);
      check("    and nothing was written", writes.filter(w => w.method === "PUT").length === 0, writes);

      /**
       * The same write, the same caller, the only difference being that the
       * team read fails. No `ownTeams` / `teamsOf` hook, so `subjectFor` falls
       * through to the real GitHub call, which the stub cannot satisfy — which
       * is exactly the shape of the transient failure.
       */
      setPermissionsTestHooks({ loadFile: () => loaded(stored), ownerOf: () => false });
      forgetPermissions();
      forgetSubjects();
      writes = [];
      const unreadable = await answerOf(handlerFor("put", "/file"), {
        user: { login: "plain", accessToken: "plain-token" }, params: {}, query: {},
        body: { file: widen, sha: "stored-sha", summary: "widen my own team" },
      });
      check("  a team read that failed is an outage, not an empty list",
        unreadable.status === 503 && unreadable.body.code === "PERMISSIONS_UNAVAILABLE", unreadable);
      check("    and nothing was written", writes.filter(w => w.method === "PUT").length === 0, writes);
    }

    console.log("\nGET /person/:login: the baseline is what the layers beneath decide");
    {
      /**
       * The admin tree edits one layer as a **difference** from the layers
       * beneath it, so it needs their verdict as a thing in its own right. The
       * screen used to derive that from `explanations` — which reports the rule
       * that won *overall* — by dropping every leaf whose origin read `set on
       * this person`. A leaf her own `revoke` was suppressing came back as "not
       * granted", indistinguishable from a leaf nothing grants, so the revoke
       * agreed with the baseline and the next unrelated tick dropped it.
       *
       * `frontend/repro-permissiontree.ts` drives the round trip this exists
       * for. This is the server half: what the route actually answers.
       */
      const stored: PermissionsFile = {
        version: 1,
        presets: {
          member: { name: "Member", grant: ["me", "overview.read"] },
          aws: { name: "AWS", grant: ["aws"] },
        },
        teams: { platform: { presets: ["aws"] } },
        people: {
          plain: { presets: ["member"], grant: ["admin.people.read"] },
          dana: { presets: ["member"], revoke: ["aws"] },
        },
      };

      const answer = await run("get", "/person/:login", {
        stored: loaded(stored), as: "plain", teams: ["platform"], params: { login: "dana" },
      });

      check("dana does not hold aws.read, because her own layer revokes it",
        !answer.body.held.includes("aws.read")
          && answer.body.explanations["aws.read"].origin === "set on this person",
        answer.body.explanations?.["aws.read"]);

      check("  but the baseline beneath her says granted, because her team grants it",
        answer.body.baseline?.["aws.read"] === true, answer.body.baseline?.["aws.read"]);

      check("  and her own rule is not in `inherited` — that is the layer being edited",
        Array.isArray(answer.body.inherited)
          && !answer.body.inherited.some((r: any) => r.origin === "set on this person"),
        answer.body.inherited);

      /**
       * At the depth it was written, not flattened to leaf depth. `decideLeaf`
       * ranks depth above layer on both sides of the wire, so a leaf-depth copy
       * of a branch rule outranks, in the client's tree, the rule it loses to
       * on the server — which is how un-ticking a branch moved no checkbox and
       * revoked fourteen leaves on save.
       */
      const teamRule = (answer.body.inherited ?? []).find((r: any) => r.origin.includes("team platform"));
      check("  the team's rule arrives at the depth it was written",
        teamRule?.node === "aws" && teamRule?.effect === "grant", teamRule);
      check("    and no rule was manufactured per leaf",
        !(answer.body.inherited ?? []).some((r: any) => r.node === "aws.read"),
        (answer.body.inherited ?? []).map((r: any) => r.node));

      /**
       * A leaf nothing beneath her decides is `false`, not missing: the tree
       * reads this map for every leaf in the vocabulary and an absent key would
       * read as "not granted" by accident rather than by answer.
       */
      check("  every leaf in the vocabulary has a verdict",
        PERMISSIONS.every(l => typeof answer.body.baseline?.[l.key] === "boolean"),
        Object.keys(answer.body.baseline ?? {}).length);
    }

    console.log("\nPOST /migrate: it generates a starting file, it does not overwrite one");
    {
      const empty: PermissionsFile = { version: 1, presets: {}, teams: {}, people: {} };

      const hasPeople = await run("post", "/migrate", {
        stored: loaded({ ...empty, people: { ana: { presets: [] } } }), as: "plain",
      });
      check("a file that already names people is refused with a conflict",
        hasPeople.status === 409 && hasPeople.body.code === "conflict", hasPeople);
      check("  and nothing was written", writes.length === 0, writes);

      /**
       * The guard checked `people` and not `presets`, while `startingFile`
       * replaces the preset table wholesale — so a curated preset table with no
       * people in it was destroyed, and three new presets created, by a caller
       * holding only `admin.people.assign`. The identical write through `PUT
       * /file` would have required `admin.presets.delete` and
       * `admin.presets.create` as well.
       */
      const curated = { ...empty, presets: { reviewer: { name: "Reviewer" }, sre: { name: "SRE" } } };
      check("the same write through PUT /file would have required the preset classes",
        changeClasses(curated as PermissionsFile, startingFile([]))
          .includes("admin.presets.delete"),
        changeClasses(curated as PermissionsFile, startingFile([])));

      const hasPresets = await run("post", "/migrate", { stored: loaded(curated as PermissionsFile), as: "plain" });
      check("a file that already has presets is refused too",
        hasPresets.status === 409 && hasPresets.body.code === "conflict", hasPresets);
      check("  and the curated presets are still there", writes.length === 0, writes);

      /**
       * And the third table, which the guard did not look at — and which is the
       * shape `docs/auth/permissions-model.md` encourages authority to be
       * delivered in.
       *
       * `startingFile` replaces `teams` with `{}` wholesale, so a file whose
       * entire content was a team grant had the caller's own source of
       * authority erased and replaced by a preset granting them everything.
       * Both guarded tables were empty, so it passed.
       */
      const viaTeams: PermissionsFile = {
        version: 1, presets: {}, people: {},
        teams: { platform: { grant: ["admin.people.assign"] } },
      };
      const caller = { login: "plain", teamSlugs: ["platform", "control-hub-admins"], isOrgOwner: false };
      const generated = startingFile([
        { login: "plain", isControlHubAdmin: true, isAwsAdmin: false, isOrgOwner: false },
      ]);
      check("the escalation is real: one leaf through `teams` becomes the whole vocabulary",
        permissionsFor(viaTeams, caller).held.join() === "admin.people.assign"
          && permissionsFor(generated, caller).held.length > 90
          && permissionsFor(generated, caller).has("admin.presets.delete"),
        { before: permissionsFor(viaTeams, caller).held,
          after: permissionsFor(generated, caller).held.length });

      const hasTeams = await run("post", "/migrate", {
        stored: loaded(viaTeams), as: "plain", teams: ["platform", "control-hub-admins"],
      });
      check("a file that delivers authority through `teams` is refused too",
        hasTeams.status === 409 && hasTeams.body.code === "conflict"
          && /teams/.test(String(hasTeams.body.error)), hasTeams);
      check("  and the team that was granting the caller their one permission is still there",
        writes.filter(w => w.method === "PUT").length === 0, writes);

      /**
       * And the rule itself, rather than the guard that happens to cover
       * today's route to it: **no write may widen the writer** is a property of
       * writing the file, and `POST /migrate` writes a whole file. The stored
       * file here cannot be read at all, so the 409 guard sees nothing to
       * discard and lets it through — and the write is still refused, because
       * generating a file that hands the caller the `control-hub-admin` preset
       * is a write that widens them.
       */
      orgSnapshot = {
        members: ["plain", "other"], owners: [],
        teams: { "control-hub-admins": ["plain", "other"], "aws-guardrail-admins": [] },
      };
      try {
        const unread = await run("post", "/migrate", {
          stored: { reason: "unreachable", detail: "GitHub is not answering" },
          as: "plain", teams: ["control-hub-admins"],
        });
        check("generating a file that would widen the caller is refused, on this route too",
          unread.status === 403 && unread.body.code === "SELF_WIDENING"
            && (unread.body.gained ?? []).includes("admin.presets.delete"), unread);
        check("  and nothing was written", writes.filter(w => w.method === "PUT").length === 0, writes);

        /**
         * It still does the job it exists for. An organization owner is exempt
         * — they already hold everything, so there is nothing to widen into —
         * and the migration is the thing they run before the flip.
         */
        const fresh = await run("post", "/migrate", {
          stored: loaded(empty), as: "plain", owner: true, teams: ["control-hub-admins"],
        });
        check("an organization with none of the three still gets its starting file",
          fresh.status === 200 && fresh.body.ok === true && fresh.body.people === 2, fresh);

        const written = JSON.parse(Buffer.from(
          writes.find(w => w.method === "PUT")!.body.content, "base64").toString("utf8"));
        check("  which reproduces today's access rather than inventing it",
          permissionsFor(written, { login: "plain", teamSlugs: [], isOrgOwner: false })
            .has("admin.presets.delete"),
          Object.keys(written.people));
      } finally {
        orgSnapshot = null;
      }
    }
  } finally {
    setPermissionsTestHooks(null);
    forgetPermissions();
    forgetSubjects();
    (globalThis as any).fetch = realFetch;
    client.disposeTokenManager();
    if (flagBefore === undefined) delete process.env.PERMISSIONS_ENABLED;
    else process.env.PERMISSIONS_ENABLED = flagBefore;
    if (orgBefore === undefined) delete process.env.GITHUB_ORG;
    else process.env.GITHUB_ORG = orgBefore;
  }
}

theAdminRouterDriven().then(() => {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (err) => {
  console.log(`  FAIL  the admin router could not be driven -> ${err?.stack ?? err}`);
  console.log("\n1 FAILED");
  process.exit(1);
});

