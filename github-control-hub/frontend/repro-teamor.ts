/**
 * Screens ask what somebody may do, not which team they are on.
 *
 * Every screen that read `isControlHubAdmin` or `isAwsAdmin` directly kept
 * asking the team after a permissions file was in force, so a tab, a button or
 * a panel stayed hidden from everybody granted it who was not on the team —
 * which is everybody a grant is for. `useTeamOr` asks the team only until a
 * file is in force.
 *
 * Run:  npx tsx repro-teamor.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(path.join(dir, d.name))
      : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
}

/**
 * Where reading the team is the point: the hook that falls back to it, the
 * route door that falls back to it, the API and demo data that carry it, and
 * the account menu's line saying which team somebody is on.
 */
const ALLOWED = new Set([
  "src/hooks/usePermissionSet.ts",
  "src/hooks/usePermissions.ts",
  "src/components/RequireTeam.tsx",
  "src/components/Navbar.tsx",
  "src/api/auth.ts",
]);

console.log("screens decide by permission once a file is in force");
{
  const offenders = walk("src")
    .filter(f => !ALLOWED.has(f) && !f.includes("/mocks/") && !f.includes("/api/"))
    .filter(f => /\.is(ControlHub|Aws)Admin\b/.test(fs.readFileSync(f, "utf8")));
  check("no screen reads isControlHubAdmin or isAwsAdmin directly", offenders.length === 0, offenders);

  const hook = fs.readFileSync("src/hooks/usePermissionSet.ts", "utf8");
  const body = hook.slice(hook.indexOf("export function useTeamOr"));
  check("useTeamOr asks the permissions once a file is in force",
    /enforced && !permissions\.inert\) return canAny\(/.test(body));

  const door = fs.readFileSync("src/components/RequireTeam.tsx", "utf8");
  check("the route door opens on a permission once a file is in force",
    /if \(enforced\)/.test(door) && /canAny\(\.\.\.permissions\)/.test(door));

  const router = fs.readFileSync("src/router.tsx", "utf8");
  const doors = [...router.matchAll(/<RequireTeam\b[^>]*>/g)].map(m => m[0]);
  check("every route door names the permissions that open it",
    doors.length > 0 && doors.every(d => /permissions=\{\[/.test(d)), doors);

  check("nothing still says organization owners are let in",
    !/owners are admitted/.test(door));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
