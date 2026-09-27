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
  "src/lib/teamOr.ts",
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

  const decide = fs.readFileSync("src/lib/teamOr.ts", "utf8");
  check("the decision consults the permissions once a file is in force",
    /permissions\?\.enforced\) return keys\.some\(/.test(decide));

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

/**
 * The decision itself, with real answers in hand.
 *
 * An AWS-only install was the reported failure: no organization, so no file and
 * nothing to enforce — every gate on the server passes — and the screen fell
 * through to a team check that cannot be satisfied there, telling somebody to
 * join `aws-guardrail-admins`.
 */
async function decisions() {
  const { decideTeamOr } = await import("./src/lib/teamOr");
  const noTeams = { isAwsAdmin: false, isControlHubAdmin: false };
  const base = { adminTeam: "control-hub-admins", held: [] as string[], failure: null };

  console.log("\nwhat opens a screen");
  check("an AWS-only install opens everything, as the server does",
    decideTeamOr({ ...base, enforced: false, inert: true }, noTeams, "aws", ["aws.read"]),
    "there is no organization to hold a file and no team to be on");

  check("an organization with no file falls back to the team",
    decideTeamOr({ ...base, enforced: false, inert: false }, noTeams, "aws", ["aws.read"]) === false
      && decideTeamOr({ ...base, enforced: false, inert: false },
        { ...noTeams, isAwsAdmin: true }, "aws", ["aws.read"]) === true);

  check("with a file in force, the permission decides and the team does not",
    decideTeamOr({ ...base, enforced: true, inert: false, held: ["aws.read"] },
      noTeams, "aws", ["aws.read"]) === true
      && decideTeamOr({ ...base, enforced: true, inert: false, held: ["me.work.read"] },
        { ...noTeams, isAwsAdmin: true }, "aws", ["aws.read"]) === false);

  check("a file that could not be read refuses, rather than falling back",
    decideTeamOr({ ...base, enforced: true, inert: false, failure: { reason: "unreachable", detail: "x" } },
      { ...noTeams, isAwsAdmin: true }, "aws", ["aws.read"]) === false,
    "the page says the answer could not be fetched; it must not quietly use the old rule");

  check("while the answer is still loading, the team decides",
    decideTeamOr(undefined, { ...noTeams, isControlHubAdmin: true }, "control-hub", ["access.read"]) === true);
}

await decisions();

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
