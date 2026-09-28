/**
 * The real backend, with GitHub and AWS faked, for driving the real frontend.
 *
 * `repro-memberview` asks every route what it answers; this is the same server
 * left running so a browser can open the actual screens as each kind of person
 * and show what they render. `e2e/render.mjs` is the driver.
 *
 * Six people, each a case the permission system has got wrong at least once:
 *
 *   fran  the `member` preset, written under the account as the console writes it
 *   carl  the `control-hub-admin` preset, not on the admin team
 *   ava   the `aws-admin` preset
 *   root  on control-hub-admins, with no entry at all
 *   nia   a narrow custom grant: the Pull requests tab and her own work
 *   ned   named in the file with nothing granted
 *
 * Run:  npx tsx e2e/harness-server.ts [github|aws-only] [port]
 * It prints one line of JSON — the port and a session token per person — once
 * it is listening, and writes the same to e2e/.sessions.json.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const MODE = process.argv[2] === "aws-only" ? "aws-only" : "github";
const PORT = Number(process.argv[3] ?? 4100);
const ACCOUNT = "123456789012";
const ADMIN_TEAM = "control-hub-admins";

const PEOPLE = ["fran", "carl", "ava", "root", "nia", "ned"] as const;
type Person = typeof PEOPLE[number];
const TEAMS: Record<string, string[]> = { root: [ADMIN_TEAM] };

async function main() {
  // ── Isolation from the machine this runs on ──────────────────────────
  for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "AWS_ONLY",
    "PERMISSIONS_ENABLED", "GITHUB_ACCOUNT_ID"]) delete process.env[k];
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-"));

  // A fake AWS that answers the one call that is not DynamoDB: the account's
  // secret. An AWS-only account's names no organization.
  const aws = http.createServer((req, res) => {
    const target = String(req.headers["x-amz-target"] ?? "");
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      // The query-protocol services (STS, SNS, …) speak XML, keyed on Action.
      const action = new URLSearchParams(body).get("Action");
      if (action) {
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(action === "GetCallerIdentity"
          ? `<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${ACCOUNT}</Account>`
            + `<Arn>arn:aws:iam::${ACCOUNT}:user/x</Arn><UserId>x</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`
          : `<${action}Response><${action}Result></${action}Result></${action}Response>`);
        return;
      }
      if (/GetSecretValue/.test(target)) {
        res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
        res.end(JSON.stringify({ Name: "s", SecretString: JSON.stringify({ JWT_SECRET: process.env.JWT_SECRET }) }));
        return;
      }
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.end("{}");
    });
  });
  await new Promise<void>(r => aws.listen(0, "127.0.0.1", () => r()));

  Object.assign(process.env, {
    __STANDALONE__: "1",
    JWT_SECRET: "harness-secret-harness-secret-harness",
    AWS_ENDPOINT_URL: `http://127.0.0.1:${(aws.address() as AddressInfo).port}`,
    AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    ACTIVITY_TABLE: "t", AUTH_CODES_TABLE: "t", GRAPH_EDGES_TABLE: "t", GUARDRAILS_TABLE: "t",
    GUARDRAIL_EXCLUSIONS_TABLE: "t", GUARDRAIL_FINDINGS_TABLE: "t", ORG_CONFIG_TABLE: "t",
    FRONTEND_URL: "http://localhost:5273",
  });
  if (MODE === "github") {
    Object.assign(process.env, {
      GITHUB_ORG: "an-org", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x", GITHUB_APP_ID: "1",
    });
  } else {
    for (const k of ["GITHUB_ORG", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_APP_ID"]) delete process.env[k];
  }

  // ── The permissions file, as the console leaves it ───────────────────
  const { startingFile } = await import("../src/permissions/migrate");
  const file: any = startingFile([
    { login: "fran", isControlHubAdmin: false, isAwsAdmin: false },
    { login: "carl", isControlHubAdmin: true, isAwsAdmin: false },
    { login: "ava", isControlHubAdmin: false, isAwsAdmin: true },
  ] as any);
  file.awsAccounts = [{ accountId: ACCOUNT, name: "Dev" }];
  const under = (e: any) => ({ accounts: { [ACCOUNT]: { presets: e.presets, grant: e.grant, revoke: e.revoke } } });
  for (const [login, entry] of Object.entries<any>(file.people)) file.people[login] = under(entry);
  // `startingFile` leaves the admin team out; a team member with no entry is
  // the ordinary case for root.
  // `startingFile` leaves anybody on the admin team out — they are exempt — so
  // carl, who holds the preset without being on the team, is written here.
  file.people.carl = under({ presets: ["control-hub-admin"] });
  file.people.nia = under({ grant: ["pulls.read", "pulls.state.read", "me"] });
  file.people.ned = under({});

  // ── A fake GitHub ────────────────────────────────────────────────────
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
      return json(200, {
        type: "file", sha: "abc", encoding: "base64",
        content: Buffer.from(JSON.stringify(file)).toString("base64"),
      });
    }
    if (p === "/repos/an-org/control-hub-permissions") return json(200, { name: "control-hub-permissions" });
    if (p === "/user/teams") {
      return json(200, (TEAMS[caller] ?? []).map(slug => ({ slug, organization: { login: "an-org" } })));
    }
    if (p === "/user") return json(200, { login: caller, id: 1 });
    if (/^\/orgs\/an-org\/memberships\//.test(p)) return json(200, { state: "active", role: "member" });
    let m = p.match(/^\/orgs\/an-org\/teams\/([^/]+)\/memberships\/([^/]+)$/);
    if (m) return (TEAMS[m[2]] ?? []).includes(m[1]) ? json(200, { state: "active", role: "member" }) : json(404, {});
    if (/^\/orgs\/an-org\/members\//.test(p)) return new Response(null, { status: 204 });
    if (p === "/orgs/an-org") return json(200, { login: "an-org" });
    if (p === "/graphql") return json(200, { data: {} });
    return json(200, []);
  };

  if (MODE === "github") {
    const { initTokenManager } = await import("../src/github/client");
    await initTokenManager("1", "key", "1", (() => async () => ({
      token: "tok-app", expiresAt: new Date(Date.now() + 3600e3).toISOString(),
    })) as any);
  }

  // DynamoDB: every read finds nothing, every write succeeds.
  const { __setDocClientForTests } = await import("../src/utils/dynamo");
  // HARNESS_AWS_COLD_MS: DynamoDB unreachable for that long after start, the
  // way a desktop launch is while the AWS credential chain resolves.
  const coldUntil = Date.now() + Number(process.env.HARNESS_AWS_COLD_MS ?? 0);
  __setDocClientForTests({
    send: async (cmd: any) => {
      if (Date.now() < coldUntil) throw new Error("harness: AWS not reachable yet");
      const name = cmd?.constructor?.name ?? "";
      return /Scan|Query/.test(name) ? { Items: [], Count: 0, ScannedCount: 0 }
        : /BatchGet/.test(name) ? { Responses: {} } : {};
    },
  });

  const app = (await import("../src/server")).default;
  const server = await new Promise<http.Server>(r => {
    const s = app.listen(PORT, "127.0.0.1", () => r(s));
  });

  if (MODE === "aws-only") {
    const until = Date.now() + 10_000;
    while (process.env.AWS_ONLY !== "true" && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  }

  const { signToken } = await import("../src/utils/jwt");
  const { storeToken } = await import("../src/utils/tokenStore");
  const sessions: Record<Person, string> = {} as any;
  PEOPLE.forEach((login, i) => {
    storeToken(i + 1, `tok-${login}`);
    sessions[login] = signToken({ githubId: i + 1, login } as any);
  });

  const out = { mode: MODE, port: (server.address() as AddressInfo).port, sessions };
  fs.writeFileSync(path.join(__dirname, ".sessions.json"), JSON.stringify(out));
  console.log(JSON.stringify(out));
}

main().catch(err => { console.error(err); process.exit(1); });
