/**
 * A permission granted is a permission that works.
 *
 * The old admin-team checks were left in front of routes that the permissions
 * file also gates — the whole Access and AWS routers, alarms, pull request
 * reminders, detailed logging, graph rebuilds, the shared Overview board. With
 * a file in force, somebody granted `pulls.pause` or the AWS tab who was not on
 * the team passed the permission gate and was then refused by the team check
 * behind it. Granting did nothing for anybody but the admin team, who hold
 * everything anyway.
 *
 * Driven against a stubbed GitHub, so what is checked is the answer somebody
 * actually gets rather than the shape of the code.
 *
 * Run:  npx tsx repro-teamgatesaside.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

process.env.GITHUB_ORG = "an-org";
delete process.env.PERMISSIONS_ENABLED;

const ADMIN_TEAM = "control-hub-admins";
/** Which teams each login is on, as GitHub would answer. */
const teams: Record<string, string[]> = { root: [ADMIN_TEAM] };
/** The committed file, or null for "the repository exists and the file does not". */
let file: unknown = null;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init?: any) => {
  const u = new URL(String(url));
  if (u.hostname !== "api.github.com") return realFetch(url, init);
  const auth = String(new Headers(init?.headers).get("authorization") ?? "");
  const caller = auth.replace(/^(token|bearer)\s+tok-/i, "");
  const p = u.pathname;

  if (p === "/repos/an-org/control-hub-permissions/contents/permissions.json") {
    if (file === null) return json(404, { message: "Not Found" });
    return json(200, {
      type: "file", sha: "abc", encoding: "base64",
      content: Buffer.from(JSON.stringify(file)).toString("base64"),
    });
  }
  if (p === "/repos/an-org/control-hub-permissions") return json(200, { name: "control-hub-permissions" });
  if (p === "/user/teams") {
    return json(200, (teams[caller] ?? []).map(slug => ({ slug, organization: { login: "an-org" } })));
  }
  let m = p.match(/^\/orgs\/an-org\/memberships\/([^/]+)$/);
  if (m) return json(200, { state: "active", role: "member" });
  m = p.match(/^\/orgs\/an-org\/teams\/([^/]+)\/memberships\/([^/]+)$/);
  if (m) {
    return (teams[m[2]] ?? []).includes(m[1])
      ? json(200, { state: "active", role: "member" })
      : json(404, { message: "Not Found" });
  }
  return json(404, { message: `unstubbed ${p}` });
};

/** Run one middleware and report what it did: passed, or refused with a status. */
function run(mw: any, login: string): Promise<{ next: true } | { status: number; body: any }> {
  return new Promise(resolve => {
    const req = { user: { login, accessToken: `tok-${login}` } };
    const res: any = {
      code: 200,
      status(n: number) { this.code = n; return this; },
      json(body: any) { resolve({ status: this.code, body }); },
    };
    mw(req, res, () => resolve({ next: true }));
  });
}

async function main() {
  const { initTokenManager } = await import("./src/github/client");
  const stubAppAuth = () => async () => ({
    token: "tok-app", expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  await initTokenManager("1", "key", "1", stubAppAuth as any);

  const { teamOrPermission, teamGatesStandAside } = await import("./src/permissions");
  const { forgetPermissions } = await import("./src/permissions/store");
  const { forgetSubjects } = await import("./src/permissions/subject");
  const { requireAwsAdmin, requireControlHubAdmin } = await import("./src/middleware/teamGate");
  const { requirePermission } = await import("./src/middleware/permissionGate");

  const reset = () => { forgetPermissions(); forgetSubjects(); };

  console.log("before a file says anything, the teams are the rule");
  {
    file = null; reset();
    check("somebody on no team is refused the AWS router",
      "status" in await run(requireAwsAdmin, "carol"));
    check("  and the Access router",
      "status" in await run(requireControlHubAdmin, "carol"));
    check("  and an inline team check",
      !(await teamOrPermission("carol", "tok-carol", "control-hub", ["pulls.pause"])));
    check("the admin team passes",
      await teamOrPermission("root", "tok-root", "control-hub", ["pulls.pause"]));
    check("the team gates do not stand aside",
      !(await teamGatesStandAside("carol", "tok-carol")));
  }

  console.log("with a file in force, the permission decides");
  {
    file = {
      version: 1, presets: {}, teams: {},
      people: {
        dave: { grant: ["aws.read", "aws.rules.read", "pulls.pause", "access.read"] },
        // Named, so the file says something; holds nothing relevant here.
        erin: { grant: ["me.work.read"] },
      },
    };
    reset();

    check("somebody granted the AWS tab, on no team, passes the AWS router",
      "next" in await run(requireAwsAdmin, "dave"), await run(requireAwsAdmin, "dave"));
    check("  and the permission gate on its route",
      "next" in await run(requirePermission("aws.rules.read"), "dave"));
    check("  and the Access router they were granted",
      "next" in await run(requireControlHubAdmin, "dave"));
    check("  and the inline check for the reminder pause they were granted",
      await teamOrPermission("dave", "tok-dave", "control-hub", ["pulls.pause"]));
    check("  but not the one for sending reminders, which they were not",
      !(await teamOrPermission("dave", "tok-dave", "control-hub", ["pulls.run"])));
    check("  and \"all\" means all",
      !(await teamOrPermission("dave", "tok-dave", "aws", ["aws.rules.read", "aws.rules.edit"], "all"))
        && await teamOrPermission("dave", "tok-dave", "aws", ["aws.rules.read", "aws.read"], "all"));

    /**
     * The router-wide gate stands aside for everybody, and the route's own
     * gate is what refuses. Checked together, because standing aside is only
     * safe while that second gate is there.
     */
    check("somebody granted nothing on AWS is refused by the route's own gate",
      (await run(requirePermission("aws.rules.read"), "erin") as any).status === 403);
    check("  and by an inline check",
      !(await teamOrPermission("erin", "tok-erin", "aws", ["aws.rules.edit"])));

    const { holdsNow } = await import("./src/permissions");
    check("editing a rule and arming one are separate permissions",
      !(await holdsNow("dave", "tok-dave", "aws.rules.enforce"))
        && await holdsNow("dave", "tok-dave", "aws.rules.read"));

    check("the admin team still holds everything",
      await teamOrPermission("root", "tok-root", "aws", ["aws.rules.edit", "pulls.run"], "all"));
  }

  console.log("a guardrail's mode needs the enforce permission, however it is reached");
  {
    const aws = fs.readFileSync("./src/routes/awsGuardrails.ts", "utf8");
    const create = aws.slice(aws.indexOf('router.post("/guardrails"'), aws.indexOf('router.put("/guardrails/:id"'));
    check("creating a rule already in enforce mode asks for aws.rules.enforce",
      /refusedWithout\(req, res, "aws\.rules\.enforce"\)/.test(create));
    const update = aws.slice(aws.indexOf('router.put("/guardrails/:id"'), aws.indexOf('router.delete("/guardrails/:id"'));
    check("updating one asks for enforce to arm it and edit for anything else",
      /intoEnforce && await refusedWithout\(req, res, "aws\.rules\.enforce"\)/.test(update)
        && /other && await refusedWithout\(req, res, "aws\.rules\.edit"\)/.test(update));
  }

  console.log("routes consult the teams only through something that steps aside");
  {
    /**
     * The structural half, so the next route written does not reintroduce it.
     * Every route file is behind a permission gate; a bare team check behind
     * one is the bug this file exists for.
     */
    const dir = "./src/routes";
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".ts"))) {
      if (f === "auth.ts") continue; // reports team membership; gates nothing
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // A call is fine only as the fallback of something that stood aside
      // first — `teamGatesStandAside(...)` just before it.
      for (const m of src.matchAll(/\bis(ControlHub|Aws)Admin\(/g)) {
        const before = src.slice(Math.max(0, m.index! - 300), m.index);
        if (!/teamGatesStandAside\(/.test(before)) offenders.push(`${f}@${m.index}`);
      }
    }
    check("no route file calls isControlHubAdmin or isAwsAdmin directly", offenders.length === 0, offenders);

    const alarms = fs.readFileSync("./src/routes/alarms.ts", "utf8");
    check("alarms' team gates step aside once a file is in force",
      (alarms.match(/teamGatesStandAside\(/g) ?? []).length >= 2);
    const gate = fs.readFileSync("./src/middleware/teamGate.ts", "utf8");
    check("so do the Access and AWS routers'", /teamGatesStandAside\(/.test(gate));
  }

  (globalThis as any).fetch = realFetch;
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
