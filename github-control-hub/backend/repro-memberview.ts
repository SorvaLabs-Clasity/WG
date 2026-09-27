/**
 * What somebody holding only the `member` preset actually gets from the server.
 *
 * Every earlier check looked at one gate at a time, and every one passed while
 * the app in front of a real member was a single locked screen: the gates were
 * right and the thing that fed them — which account this install is — was
 * never set on a member's request. So this drives the real server, end to end,
 * as that member: the real Express app, the real middleware stack, the real
 * member preset from the migration, written the way the console writes it
 * (under an account id). Only GitHub and AWS are fake.
 *
 * It asks every GET route and sorts the answers:
 *
 *   - a refusal naming a *team* is a bug: with a file in force, teams do not
 *     decide anything;
 *   - "permissions could not be read" is a bug: nothing here is unreadable;
 *   - a refusal naming a permission is correct — but only if no screen the
 *     member can open asks for it on load. `MEMBER_SCREENS` below lists what
 *     each of the member's tabs loads, and each must be allowed.
 *
 * Run:  npx tsx repro-memberview.ts            (GitHub install, file in force)
 *       npx tsx repro-memberview.ts aws-only   (no organization at all)
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import type { AddressInfo } from "node:net";

const MODE = process.argv[2] === "aws-only" ? "aws-only" : "github";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got, null, 2)}`}`);
}

const ACCOUNT = "123456789012";

// ── A fake AWS: every service answers "nothing here" ───────────────────
//
// So routes run their permission checks and then find no data, rather than
// failing on credentials before a check is reached. STS names the account,
// because that is what the install-account lookup asks.
const aws = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    const target = String(req.headers["x-amz-target"] ?? "");
    if (/GetCallerIdentity/.test(body) || /GetCallerIdentity/.test(target)) {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${ACCOUNT}</Account>`
        + `<Arn>arn:aws:iam::${ACCOUNT}:user/x</Arn><UserId>x</UserId></GetCallerIdentityResult>`
        + `</GetCallerIdentityResponse>`);
      return;
    }
    // The account's secret. An AWS-only account's names no organization, which
    // is what the startup loader has to recognise; a GitHub account's is never
    // read here, because its credentials are already in the environment.
    if (/GetSecretValue/.test(target)) {
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify({ Name: "s", SecretString: JSON.stringify({ JWT_SECRET: process.env.JWT_SECRET }) }));
      return;
    }
    res.writeHead(200, { "content-type": "application/x-amz-json-1.0" });
    res.end(/Scan|Query/.test(target) ? JSON.stringify({ Items: [], Count: 0, ScannedCount: 0 }) : "{}");
  });
});

// ── The member, and the file as the console writes it ──────────────────
const LOGIN = "fran";

async function main() {
  await new Promise<void>(r => aws.listen(0, "127.0.0.1", () => r()));
  const awsUrl = `http://127.0.0.1:${(aws.address() as AddressInfo).port}`;

  Object.assign(process.env, {
    __STANDALONE__: "1",
    JWT_SECRET: "test-secret-test-secret-test-secret",
    AWS_ENDPOINT_URL: awsUrl,
    AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    ACTIVITY_TABLE: "t", AUTH_CODES_TABLE: "t", GRAPH_EDGES_TABLE: "t", GUARDRAILS_TABLE: "t",
    GUARDRAIL_EXCLUSIONS_TABLE: "t", GUARDRAIL_FINDINGS_TABLE: "t", ORG_CONFIG_TABLE: "t",
  });
  delete process.env.PERMISSIONS_ENABLED;
  delete process.env.GITHUB_ACCOUNT_ID;
  delete process.env.AWS_ONLY;
  // A developer's own profile would win over the fake credentials and send
  // every call to their real account.
  for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"]) delete process.env[k];
  // And the desktop app's remembered profile, which the server restores from
  // the home directory at startup — so a home with nothing remembered in it.
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/memberview-`);
  if (MODE === "github") {
    Object.assign(process.env, {
      GITHUB_ORG: "an-org", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x", GITHUB_APP_ID: "1",
    });
  } else {
    for (const k of ["GITHUB_ORG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_ID"]) delete process.env[k];
  }

  const { startingFile } = await import("./src/permissions/migrate");
  const file: any = startingFile([
    { login: LOGIN, isControlHubAdmin: false, isAwsAdmin: false } as any,
  ]);
  // What the console does the first time anybody is edited with an account in
  // play: everything moves under the account id and the top level empties.
  file.awsAccounts = [{ accountId: ACCOUNT, name: "Dev" }];
  for (const [login, entry] of Object.entries<any>(file.people)) {
    file.people[login] = { accounts: { [ACCOUNT]: { presets: entry.presets, grant: entry.grant, revoke: entry.revoke } } };
  }
  check("the member preset is the migration's own, assigned as the console writes it",
    JSON.stringify(file.people[LOGIN].accounts[ACCOUNT].presets) === JSON.stringify(["member"]),
    file.people[LOGIN]);

  // ── A fake GitHub ────────────────────────────────────────────────────
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") return realFetch(url, init);
    const p = u.pathname;
    if (p === "/repos/an-org/control-hub-permissions/contents/permissions.json") {
      return json(200, {
        type: "file", sha: "abc", encoding: "base64",
        content: Buffer.from(JSON.stringify(file)).toString("base64"),
      });
    }
    if (p === "/user/teams") return json(200, []);
    if (p === "/user") return json(200, { login: LOGIN, id: 1 });
    if (/^\/orgs\/an-org\/memberships\//.test(p)) return json(200, { state: "active", role: "member" });
    if (/^\/orgs\/an-org\/teams\/[^/]+\/memberships\//.test(p)) return json(404, { message: "Not Found" });
    if (/^\/orgs\/an-org\/members\//.test(p)) return new Response(null, { status: 204 });
    // Everything else: an empty answer. Lists are what most callers expect.
    return json(200, []);
  };

  if (MODE === "github") {
    const { initTokenManager } = await import("./src/github/client");
    await initTokenManager("1", "key", "1", (() => async () => ({
      token: "tok-app", expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    })) as any);
  }

  // DynamoDB, through the seam the client module keeps for exactly this: every
  // read finds nothing and every write succeeds, so routes get as far as their
  // permission checks and then run on empty data.
  const { __setDocClientForTests } = await import("./src/utils/dynamo");
  __setDocClientForTests({
    send: async (cmd: any) => {
      const name = cmd?.constructor?.name ?? "";
      return /Scan|Query/.test(name) ? { Items: [], Count: 0, ScannedCount: 0 }
        : /BatchGet/.test(name) ? { Responses: {} } : {};
    },
  });

  const app = (await import("./src/server")).default;
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  if (MODE === "aws-only") {
    // The server's own startup read of the account's secret — the real
    // loader, not a variable set by this test. Nothing sets AWS_ONLY for the
    // server; it has to come from what that read found.
    const until = Date.now() + 10_000;
    while (process.env.AWS_ONLY !== "true" && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    check("the startup secret read recognises an account with no organization",
      process.env.AWS_ONLY === "true", process.env.AWS_ONLY);
  }

  const { signToken } = await import("./src/utils/jwt");
  const { storeToken } = await import("./src/utils/tokenStore");
  storeToken(1, "tok-fran");
  const bearer = `Bearer ${signToken({ githubId: 1, login: LOGIN } as any)}`;

  const get = async (path: string) => {
    const r = await realFetch(base + path, { headers: { authorization: bearer } });
    let body: any = null;
    try { body = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, code: body?.code as string | undefined, permission: body?.permission, body };
  };

  // ── Every GET route the server has ────────────────────────────────────
  const serverSrc = fs.readFileSync("./src/server.ts", "utf8");
  const imports = new Map([...serverSrc.matchAll(/import (\w+) from "\.\/routes\/(\w+)"/g)].map(m => [m[1], m[2]]));
  const mounts = [...serverSrc.matchAll(/app\.use\("(\/api\/[^"]+)"[^;]*?(\w+)\);/g)]
    .filter(m => imports.has(m[2]))
    .map(m => ({ prefix: m[1], file: imports.get(m[2])! }));
  const SAMPLE: Record<string, string> = {
    id: "x", login: LOGIN, repo: "r", owner: "o", q: "q", feed: "dependabot-alert", number: "1",
    name: "n", kind: "k", org: "an-org", account: ACCOUNT, address: "a", widgetId: "w", team: "t",
  };
  const routes: string[] = [];
  for (const { prefix, file: f } of mounts) {
    if (f === "auth") continue;
    const src = fs.readFileSync(`./src/routes/${f}.ts`, "utf8");
    for (const m of src.matchAll(/router\.get\(\s*"([^"]+)"/g)) {
      routes.push(prefix + m[1].replace(/:(\w+)/g, (_, k) => SAMPLE[k] ?? "x").replace(/\/$/, ""));
    }
  }
  const unique = [...new Set(routes)];

  const answers = new Map<string, Awaited<ReturnType<typeof get>>>();
  for (const r of unique) answers.set(r, await get(r));

  const teamRefusals = [...answers].filter(([, a]) => a.status === 403
    && /ADMIN_REQUIRED/.test(a.code ?? ""));
  const unreadable = [...answers].filter(([, a]) => a.code === "PERMISSIONS_UNAVAILABLE");
  const denied = [...answers].filter(([, a]) => a.code === "PERMISSION_REQUIRED");

  console.log(`\n${MODE}: ${unique.length} GET routes asked as a member`);
  // The harness itself: if AWS is unreachable every route answers 503 before
  // any permission is checked, and every check below would pass for nothing.
  const expired = [...answers].filter(([, a]) => a.code === "AWS_SESSION_EXPIRED");
  check("the harness reached the routes (not stopped by the AWS health check)",
    expired.length === 0, expired.slice(0, 3).map(([r]) => r));
  check("no route refuses the member by team", teamRefusals.length === 0,
    teamRefusals.map(([r, a]) => `${r} -> ${a.code}`));
  check("no route says the permissions could not be read", unreadable.length === 0,
    unreadable.map(([r, a]) => `${r} -> ${a.body?.error}`));

  // What the server says about the member, which is what the screens render from.
  const me = await get("/api/me/permissions");
  if (MODE === "github") {
    check("the member's own answer is enforced, readable and not empty",
      me.status === 200 && me.body?.enforced === true && me.body?.inert === false
        && !me.body?.failure && (me.body?.held?.length ?? 0) > 0,
      { status: me.status, enforced: me.body?.enforced, inert: me.body?.inert, failure: me.body?.failure, held: me.body?.held?.length });
  } else {
    check("an AWS-only install answers inert, so every screen opens",
      me.status === 200 && me.body?.inert === true, me.body);
    check("  and refuses nothing by permission", denied.length === 0,
      denied.map(([r, a]) => `${r} -> ${a.permission}`));

    /**
     * The half of the app an AWS-only account has. GitHub routes answer
     * GITHUB_NOT_HERE there, which is right; these must get past every gate.
     * "Could not verify team membership" is a gate failing, not data missing:
     * the AWS tab and the alarms both answered it, because the old team check
     * needs an organization that an AWS-only account does not have.
     */
    const awsHalf = [...answers].filter(([r]) => /^\/api\/(aws|alarms|activity)(\/|$)/.test(r));
    const blocked = awsHalf.filter(([, a]) => a.status === 401 || a.status === 403
      || (a.status === 503 && /team membership|Permissions could not be read/i.test(a.body?.error ?? "")));
    check("the AWS tab, Alarms and Activity get past every gate", awsHalf.length > 0 && blocked.length === 0,
      blocked.map(([r, a]) => `${r} -> ${a.status} ${a.code ?? ""} ${a.body?.error ?? ""}`));
  }

  /**
   * The member's tabs, and what each loads the moment it opens. Every one of
   * these must be answered — a refusal here is a panel that errors on a screen
   * the member was told they could open.
   */
  if (MODE === "github") {
    const held: string[] = me.body?.held ?? [];
    const MEMBER_SCREENS: Record<string, string[]> = {
      "My work": ["/api/me/work", "/api/me/repos"],
      Overview: ["/api/widgets", "/api/widgets/snapshots", "/api/alarms"],
      Alarms: ["/api/alarms"],
      Vulnerabilities: ["/api/security/dependabot"],
      Repos: ["/api/graph/meta"],
      "Pull requests": ["/api/pulls"],
      Activity: ["/api/activity"],
    };
    const NAV: Record<string, string[]> = {
      "My work": ["me.work.read", "me.repos.read"],
      Overview: ["overview.read", "overview.cards.read"],
      Alarms: ["alarms.org.read", "me.alarms.read", "me.destination.read"],
      Vulnerabilities: ["deps.read"],
      Repos: ["repos.read"],
      "Pull requests": ["pulls.read"],
      Activity: ["activity.read.own", "activity.read.app.rows", "activity.read.github"],
    };
    console.log("\nthe tabs a member is shown, and what they load");
    for (const [tab, keys] of Object.entries(NAV)) {
      check(`the ${tab} tab is shown`, keys.some(k => held.includes(k)), keys);
    }
    for (const [tab, paths] of Object.entries(MEMBER_SCREENS)) {
      const refused = [];
      for (const p of paths) {
        const a = answers.get(p) ?? await get(p);
        if (a.status === 403 || a.status === 401 || a.code === "PERMISSIONS_UNAVAILABLE") refused.push(`${p} -> ${a.status} ${a.code ?? ""} ${a.permission ?? ""}`);
      }
      check(`  ${tab} loads without a refusal`, refused.length === 0, refused);
    }

    console.log("\nrefused by permission — correct only if no member screen asks on load:");
    for (const [r, a] of denied) console.log(`        ${r}  (${a.permission})`);
  }

  server.close(); aws.close();
  (globalThis as any).fetch = realFetch;
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
