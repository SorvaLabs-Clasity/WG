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
import { emptyFile } from "./src/permissions/types";

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
   * Reading the file means reading who holds what across the organization —
   * the same aggregation the access map is gated on. Writing it is the most
   * privileged act in the app.
   */
  for (const [path, permission] of [
    ['router.get("/file"', "admin.people.read"],
    ['router.put("/file"', "admin.people.assign"],
    ['router.get("/vocabulary"', "admin.console.open"],
    ['router.get("/person/:login"', "admin.people.read"],
    ['router.get("/audit"', "admin.audit.read"],
    ['router.post("/bootstrap"', "admin.people.assign"],
  ] as const) {
    const at = admin.indexOf(path);
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check(`  ${path.slice(12)} needs ${permission}`,
      at >= 0 && line.includes(`requirePermission("${permission}")`), line.trim());
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
