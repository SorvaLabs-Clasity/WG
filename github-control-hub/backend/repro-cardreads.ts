/**
 * A card is absent to somebody who may not read its data.
 *
 * docs/auth/permissions-model.md, "Overview is not a side channel": a card
 * shows another tab's data, so whoever may not read that data does not see the
 * card, cannot make one, and cannot set an alarm on one (the email would carry
 * its numbers). Also checks that the two copies of the rule — the server's in
 * src/permissions/cardReads.ts and the add-card form's in
 * frontend/src/lib/widgetPresets.ts — agree, and that every permission the
 * admin console's "needs" warnings name (frontend/src/lib/permissionNeeds.ts)
 * is a real one.
 *
 * Run:  npx tsx repro-cardreads.ts   from github-control-hub/backend
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

const PEOPLE: Record<string, string[]> = {
  pia: ["me"],                                   // their own board, no repository checks
  quinn: ["me", "repos.query.read"],             // their own board, and the checks
  board: ["overview.read", "overview.cards.read"],
  boardq: ["overview.read", "overview.cards.read", "repos.query.read", "deps.read"],
};

async function main() {
  for (const k of ["AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN", "AWS_ONLY", "PERMISSIONS_ENABLED", "GITHUB_ACCOUNT_ID"]) delete process.env[k];
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/cardreads-`);
  Object.assign(process.env, {
    __STANDALONE__: "1", JWT_SECRET: "cardreads-secret-cardreads-secret",
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
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json };
  };

  console.log("the two copies of the rule agree");
  {
    const server = await import("./src/permissions/cardReads");
    const form = await import("../frontend/src/lib/widgetPresets");
    const shapes = [
      { type: "query" }, { type: "preset", presetId: "dependabot" }, { type: "preset", presetId: "vuln-repos" },
      { type: "preset", presetId: "renovate-open" }, { type: "preset", presetId: "bypasses" },
      { type: "preset", presetId: "something-new" },
      ...Object.keys(form.PRESET_LABELS).map(presetId => ({ type: "preset", presetId })),
    ];
    const differ = shapes.filter(s => server.cardReads(s).join() !== form.cardReads(s).join());
    check(`  for ${shapes.length} kinds of card`, differ.length === 0, differ);
  }

  console.log("\nthe console's warnings name real permissions");
  {
    const { LEAF_KEYS: known } = await import("./src/permissions/vocabulary");
    const { PERMISSION_NEEDS } = await import("../frontend/src/lib/permissionNeeds");
    const unknown = Object.entries(PERMISSION_NEEDS).flatMap(([f, n]) => [f, ...n]).filter(k => !known.has(k));
    check("  every feature and every list it needs", known.size > 0 && unknown.length === 0, unknown);
  }

  console.log("\nmaking a card");
  const card = { title: "Checks", type: "query", queryId: "q1", displayType: "table", personal: true };
  const refused = await ask("pia", "POST", "/api/widgets", card);
  check("a person without the checks cannot put one on their board", refused.status === 403 && refused.json?.permission === "repos.query.read", refused);
  const made = await ask("quinn", "POST", "/api/widgets", card);
  check("  a person with them can", made.status === 201 || made.status === 200, made);
  const shared = await ask("board", "POST", "/api/widgets", { ...card, personal: false });
  check("  and a board reader without create is refused as before", shared.status === 403, shared.status);

  console.log("\nseeing a card");
  const { createWidget } = await import("./src/services/widgetService");
  const hidden = await createWidget({ title: "Checks", type: "query", queryId: "q1", displayType: "table", owner: "pia" } as any, "test");
  const deps = await createWidget({ title: "Vulns", type: "preset", presetId: "dependabot", displayType: "table" } as any, "test");
  const shown = await createWidget({ title: "Renovate", type: "preset", presetId: "renovate-open", displayType: "table" } as any, "test");
  const piaBoard = await ask("pia", "GET", "/api/widgets?scope=personal");
  check("a card made of data you cannot read is left off your own board",
    piaBoard.status === 200 && !piaBoard.json.some((w: any) => w.id === hidden.id), piaBoard);
  const quinnBoard = await ask("quinn", "GET", "/api/widgets?scope=personal");
  check("  while a card you can read stays", quinnBoard.status === 200 && quinnBoard.json.some((w: any) => w.id === made.json?.id), quinnBoard);
  const overview = await ask("board", "GET", "/api/widgets");
  check("Overview leaves out a vulnerabilities card for somebody without that read",
    overview.status === 200 && !overview.json.some((w: any) => w.id === deps.id) && !overview.json.some((w: any) => w.id === shown.id), overview);
  const overviewQ = await ask("boardq", "GET", "/api/widgets");
  check("  and shows it to somebody with it, and not the Renovate one they lack",
    overviewQ.status === 200 && overviewQ.json.some((w: any) => w.id === deps.id) && !overviewQ.json.some((w: any) => w.id === shown.id), overviewQ);

  console.log("\nan alarm on a card");
  const alarm = await ask("pia", "POST", "/api/me/alarms", { widgetId: hidden.id, condition: { field: "count", op: "gt", value: 0 } });
  check("cannot be set on a card whose data you cannot read", alarm.status === 403 && /cannot carry an alarm/.test(alarm.json?.error ?? ""), alarm);

  server.close();
  (globalThis as any).fetch = realFetch;
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
