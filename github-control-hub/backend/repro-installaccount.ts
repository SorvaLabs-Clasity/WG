/**
 * Per-account permissions must work for somebody who never opens the admin tab.
 *
 * The console writes a person's permissions **under an account id** — that is
 * what `materialise` does the first time anybody is edited while an account is
 * declared. Resolution then asks `installAccountId()` which account this
 * process is, and only two routes ever set it: the admin console's vocabulary
 * read and the AWS accounts read. A signed-in member touches neither.
 *
 * So the account was unknown, resolution fell back to the entry's top-level
 * fields — which `materialise` had just emptied — and somebody holding the
 * `member` preset held nothing. They got the "no permissions granted yet"
 * screen with an empty section line, which is exactly what was reported.
 *
 * Run:  npx tsx repro-installaccount.ts   from github-control-hub/backend
 */
let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

process.env.GITHUB_ORG = "an-org";
delete process.env.PERMISSIONS_ENABLED;

const ACCOUNT = "123456789012";
/** What the console writes: nothing at the top level, everything under the account. */
const file = {
  version: 1,
  awsAccounts: [{ accountId: ACCOUNT, name: "Dev" }],
  presets: {
    member: { name: "Member", grant: ["me", "overview.read", "activity.read.own"] },
  },
  teams: {},
  people: {
    fran: { accounts: { [ACCOUNT]: { presets: ["member"] } } },
  },
};

/** Whether the STS call that says which account this is can answer. */
let awsReachable = true;
let stsCalls = 0;

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
  if (/^\/orgs\/an-org\/memberships\//.test(p)) return json(200, { state: "active", role: "member" });
  if (/^\/orgs\/an-org\/teams\/[^/]+\/memberships\//.test(p)) return json(404, { message: "Not Found" });
  return json(404, { message: `unstubbed ${p}` });
};

async function main() {
  const { initTokenManager } = await import("./src/github/client");
  await initTokenManager("1", "key", "1", (() => async () => ({
    token: "tok-app", expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  })) as any);

  const { setInstallAccount } = await import("./src/permissions/accountScope");
  const { forgetInstallAccount } = await import("./src/permissions/installAccount");
  const { accessForSelf } = await import("./src/permissions");
  const { forgetPermissions } = await import("./src/permissions/store");
  const { forgetSubjects } = await import("./src/permissions/subject");
  const { __setAccountResolver } = await import("./src/permissions/installAccount");

  __setAccountResolver(async () => {
    stsCalls++;
    if (!awsReachable) throw new Error("no AWS credentials");
    return ACCOUNT;
  });

  const reset = () => {
    forgetPermissions(); forgetSubjects(); setInstallAccount(undefined); forgetInstallAccount();
    stsCalls = 0;
  };

  console.log("a member who never opens the admin tab holds what they were given");
  {
    reset();
    const access = await accessForSelf("fran", "tok-fran");
    check("their permissions are not empty",
      access.permissions.held.length > 0,
      "the console writes under an account id; resolution has to know which account this is");
    check("  and are the ones the preset grants",
      access.permissions.has("overview.read") && access.permissions.has("activity.read.own"));
    check("  and nothing else",
      !access.permissions.has("admin.console.open"));
  }

  console.log("which account this is costs one call, not one per request");
  {
    reset();
    for (let i = 0; i < 5; i++) await accessForSelf("fran", "tok-fran");
    check("five requests ask AWS once", stsCalls === 1, stsCalls);
  }

  console.log("when AWS cannot be asked, the declared account is used");
  {
    reset();
    awsReachable = false;
    const access = await accessForSelf("fran", "tok-fran");
    check("the file declares one account, so that is the one",
      access.permissions.has("overview.read"),
      "refusing everybody because an STS call failed is the worse answer");

    /**
     * And it is not retried on every request. A failing call on the request
     * path is how this app has burned its own budget before.
     */
    const after = stsCalls;
    for (let i = 0; i < 5; i++) await accessForSelf("fran", "tok-fran");
    check("  and the failed lookup is not repeated on every request", stsCalls === after, stsCalls);
    awsReachable = true;
  }

  console.log("two declared accounts and no answer from AWS is not a guess");
  {
    reset();
    awsReachable = false;
    (file as any).awsAccounts = [
      { accountId: ACCOUNT, name: "Dev" }, { accountId: "222222222222", name: "Prod" },
    ];
    forgetPermissions();
    const access = await accessForSelf("fran", "tok-fran");
    check("nothing is assumed, so nothing is granted",
      access.permissions.held.length === 0,
      "picking one of two accounts would grant access in an account nobody chose");
    check("  and it is reported as a failure to ask, not as a refusal",
      access.failure !== null && /account/i.test(access.failure!.detail), access.failure);
    (file as any).awsAccounts = [{ accountId: ACCOUNT, name: "Dev" }];
    awsReachable = true;
  }

  console.log("an account the file does not declare, but writes entries under");
  {
    /**
     * The console offers a tab for the account this install is in whether or
     * not anybody declared it, so this file shape is ordinary — and reading
     * only `awsAccounts` left it unresolvable.
     */
    reset();
    awsReachable = false;
    const declared = (file as any).awsAccounts;
    delete (file as any).awsAccounts;
    forgetPermissions();
    const access = await accessForSelf("fran", "tok-fran");
    check("the account its entries are written under is the one",
      access.permissions.has("overview.read"),
      "the entries name exactly one account, so there is nothing to guess");
    (file as any).awsAccounts = declared;
    awsReachable = true;
  }

  (globalThis as any).fetch = realFetch;
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
