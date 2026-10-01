/**
 * A feature's own permission is enough to use it.
 *
 * Reported: an alarm on a personal widget needed the *organization's* alarm
 * permission. The popup read the template variables and the widget's
 * conditions from routes gated on `alarms.org.read`, so the personal feature
 * worked only for people who also held the organization one. The same shape
 * was elsewhere: the security and feed email editors, the people and
 * repository pickers, the cards on Overview and on somebody's own board, and
 * the default time zone in the email groups panel.
 *
 * Driven through the real server, as people who each hold one feature and
 * nothing else, asking for exactly what that feature's screen asks for. A
 * refusal is a feature somebody was given and cannot use.
 *
 * Run:  npx tsx repro-featurereach.ts   from github-control-hub/backend
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import type { AddressInfo } from "node:net";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

/** Each person holds one feature, and the screens they need to reach it. */
const PEOPLE: Record<string, string[]> = {
  pia: ["me"],                                                      // everything personal, nothing else
  sec: ["alarms.security.read", "alarms.security.manage"],
  feed: ["alarms.feeds.read", "alarms.feeds.manage"],
  muter: ["pulls.read", "pulls.mute"],
  expert: ["expertise.read"],
  groups: ["alarms.groups.read", "alarms.groups.manage"],
  board: ["overview.read", "overview.cards.read"],
  nobody: ["pulls.read"],                                           // the control: holds none of the above
};

async function main() {
  for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "AWS_ONLY", "PERMISSIONS_ENABLED", "GITHUB_ACCOUNT_ID"]) delete process.env[k];
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/featurereach-`);
  Object.assign(process.env, {
    __STANDALONE__: "1", JWT_SECRET: "featurereach-secret-featurereach-secret",
    GITHUB_ORG: "an-org", GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "x", GITHUB_APP_ID: "1",
    AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_REGION: "us-east-1", AWS_EC2_METADATA_DISABLED: "true",
    ACTIVITY_TABLE: "t", AUTH_CODES_TABLE: "t", GRAPH_EDGES_TABLE: "t", GUARDRAILS_TABLE: "t",
    GUARDRAIL_EXCLUSIONS_TABLE: "t", GUARDRAIL_FINDINGS_TABLE: "t", ORG_CONFIG_TABLE: "t",
  });

  const ACCOUNT = "123456789012";
  const file = {
    version: 1, presets: {}, teams: {}, awsAccounts: [{ accountId: ACCOUNT, name: "Dev" }],
    people: Object.fromEntries(Object.entries(PEOPLE).map(([login, grant]) => [login, { accounts: { [ACCOUNT]: { grant } } }])),
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = new URL(String(url));
    if (u.hostname !== "api.github.com") return realFetch(url, init);
    const p = u.pathname;
    if (p === "/repos/an-org/control-hub-permissions/contents/permissions.json") {
      return json(200, { type: "file", sha: "abc", encoding: "base64", content: Buffer.from(JSON.stringify(file)).toString("base64") });
    }
    if (p === "/user/teams") return json(200, []);
    if (/^\/orgs\/an-org\/memberships\//.test(p)) return json(200, { state: "active", role: "member" });
    if (/^\/orgs\/an-org\/teams\/[^/]+\/memberships\//.test(p)) return json(404, {});
    if (/^\/orgs\/an-org\/members\//.test(p)) return new Response(null, { status: 204 });
    return json(200, []);
  };
  const { initTokenManager } = await import("./src/github/client");
  await initTokenManager("1", "key", "1", (() => async () => ({ token: "tok-app", expiresAt: new Date(Date.now() + 3600e3).toISOString() })) as any);

  const { __setDocClientForTests } = await import("./src/utils/dynamo");
  __setDocClientForTests({
    send: async (cmd: any) => {
      const name = cmd?.constructor?.name ?? "";
      return /Scan|Query/.test(name) ? { Items: [], Count: 0, ScannedCount: 0 } : /BatchGet/.test(name) ? { Responses: {} } : {};
    },
  });
  const { setInstallAccount } = await import("./src/permissions/accountScope");
  setInstallAccount(ACCOUNT);

  const app = (await import("./src/server")).default;
  const server = await new Promise<http.Server>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { signToken } = await import("./src/utils/jwt");
  const { storeToken } = await import("./src/utils/tokenStore");
  const tokens: Record<string, string> = {};
  Object.keys(PEOPLE).forEach((login, i) => { storeToken(i + 1, `tok-${login}`); tokens[login] = signToken({ githubId: i + 1, login } as any); });

  const ask = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await realFetch(base + path, {
      method, headers: { authorization: `Bearer ${tokens[who]}`, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return r.status;
  };
  /** Answered: anything but a refusal. A 404 or a 500 on empty data is past the gate. */
  const reaches = async (who: string, method: string, path: string, body?: unknown) =>
    (await ask(who, method, path, body)) !== 403;

  // The harness itself: a refusal must come from the permission gate, so the
  // requests have to get that far — an AWS outage answers 503 to everything,
  // and every "reaches" below would pass for nothing.
  check("the harness reaches the permission gates",
    (await ask("pia", "GET", "/api/me/permissions")) === 200 && (await ask("nobody", "GET", "/api/me/alarms")) === 403);

  console.log("an alarm on your own card needs only the personal alarm permission");
  check("the template variables", await reaches("pia", "GET", "/api/alarms/variables"));
  check("  the card's conditions", await reaches("pia", "GET", "/api/alarms/widgets/w1/conditions"));
  check("  and saving it", await reaches("pia", "POST", "/api/me/alarms", {}));
  check("while somebody without it is still refused", !(await reaches("nobody", "GET", "/api/alarms/variables")));
  check("  and the organization's alarms stay closed to the personal permission", !(await reaches("pia", "GET", "/api/alarms")));

  /**
   * The other side of the line, as docs/auth/permissions-model.md draws it:
   * the data a card shows, the repository and people lists behind the pickers,
   * and the email groups are other screens' data, each with its own read. A
   * board or a picker is not a way around those. Asserted so that widening any
   * of them is a decision somebody makes, not a side effect of a fix.
   */
  console.log("\nwhat stays behind its own permission");
  for (const path of ["/api/graph/query?q=x", "/api/security/dependencies", "/api/repos"]) {
    check(`  a board does not open ${path}`, !(await reaches("board", "GET", path)) && !(await reaches("pia", "GET", path)));
  }
  check("  muting somebody does not open the people list", !(await reaches("muter", "GET", "/api/org/members")));
  check("  an editor does not open the email groups", !(await reaches("sec", "GET", "/api/alarms/groups")));

  console.log("\nthe security and feed email editors");
  check("security notifications reach the template variables", await reaches("sec", "GET", "/api/alarms/variables"));
  check("feed notifications reach them too", await reaches("feed", "GET", "/api/alarms/variables"));

  console.log("\nthe default time zone, from the email groups panel");
  check("a groups reader can read it", await reaches("groups", "GET", "/api/alarms/security"));
  {
    const r = await realFetch(base + "/api/alarms/security", { headers: { authorization: `Bearer ${tokens.groups}` } });
    const body = await r.json();
    check("  and only it — the rest of the record is the security notifications",
      Object.keys(body).join() === "timezone" || Object.keys(body).length === 0, Object.keys(body));
  }
  check("a groups manager can change it", await reaches("groups", "PUT", "/api/alarms/security", { timezone: "Europe/London" }));
  check("  but nothing else on the security notifications",
    (await ask("groups", "PUT", "/api/alarms/security", { enabled: true, groupId: "g" })) === 403);

  server.close();
  (globalThis as any).fetch = realFetch;
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
