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
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
