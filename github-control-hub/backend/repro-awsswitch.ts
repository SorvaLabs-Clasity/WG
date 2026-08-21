/**
 * Switching AWS accounts without being signed out of GitHub.
 *
 * You sign in once — AWS credentials for one account, then GitHub — and from
 * then on you can move between accounts from inside the app: dev, where the
 * GitHub half lives, and uat, which holds no GitHub credentials at all and
 * shows only the AWS and Activity tabs. Your GitHub identity is *yours*, not
 * the account's: it is what says you are in `aws-guardrail-admins`, and that
 * question is worth asking in every account.
 *
 * Two separate things used to end the session at the moment of the switch, and
 * only one of them is obvious:
 *
 *   1. **The signing key is per account.** `JWT_SECRET` is read out of each
 *      account's secret, so a session minted under dev stops verifying the
 *      instant uat's secrets load. The token is not tampered with and the user
 *      is not gone — it is being checked against the wrong key, and the app
 *      reports that as "invalid or expired token".
 *
 *   2. **The organization membership check has nothing to check against.**
 *      Every request re-asks GitHub whether you are still in the org. In an
 *      account with no GitHub credentials there is no organization configured,
 *      so `getOrg()` throws, the check reads the throw as "could not ask", and
 *      "could not ask" degrades to *not a member* once the cached yes ages
 *      out. The session then dies an hour after the switch rather than at it,
 *      which is worse: it looks like a random logout rather than a switch.
 *
 * Both are fixed here. What must NOT be lost in fixing them:
 *
 *   - a re-issued session must not extend itself. Carrying a session across a
 *     switch is not a reason to be signed in for longer than 8 hours.
 *   - a session that has genuinely expired must not be revived by switching.
 *   - switching while signed out must keep working, because that is the setup
 *     flow: AWS has to be connected before GitHub secrets can be read at all.
 *   - skipping the membership check must be scoped to accounts with no GitHub
 *     credentials. Where there *is* an organization, a removed member must
 *     still be refused.
 */
import { captureSession, reissueSession, signToken, verifyToken } from "./src/utils/jwt";
import { hasGithubCredentials } from "./src/middleware/githubGate";
import { membershipCheckable } from "./src/middleware/authMiddleware";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const USER = { githubId: 4242, login: "test-user", avatarUrl: "https://example.invalid/a.png" };

function verifies(token: string): boolean {
  try { verifyToken(token); return true; } catch { return false; }
}

(async () => {
  // ── the signing key changes underneath a live session ────────────────
  {
    process.env.JWT_SECRET = "dev-account-key";
    const issued = signToken(USER);
    check("a session signed in the dev account verifies there", verifies(issued));

    // Captured before the switch, which is the only moment it can be: after
    // the reload the key that signed it is gone from the process.
    const carried = captureSession(`Bearer ${issued}`);
    check("  and can be captured while that key is still loaded", !!carried);

    process.env.JWT_SECRET = "uat-account-key";
    check("  after switching accounts the original stops verifying",
      !verifies(issued), "this is the logout nobody asked for");

    const reissued = reissueSession(carried!);
    check("  but the carried session can be re-signed for the new account",
      !!reissued && verifies(reissued!));

    const after = verifyToken(reissued!);
    check("  and it is the same person, not a new session",
      after.login === USER.login && after.githubId === USER.githubId
        && after.avatarUrl === USER.avatarUrl,
      after);
  }

  // ── a switch is not a renewal ────────────────────────────────────────
  {
    process.env.JWT_SECRET = "dev-account-key";
    const issued = signToken(USER);
    const carried = captureSession(`Bearer ${issued}`)!;
    const originalExp = (verifyToken(issued) as any).exp as number;

    process.env.JWT_SECRET = "uat-account-key";
    const reissued = reissueSession(carried)!;
    const newExp = (verifyToken(reissued) as any).exp as number;

    // Within a second, because the two are computed a moment apart.
    check("switching does not extend the session's expiry",
      Math.abs(newExp - originalExp) <= 1, { originalExp, newExp });
  }

  // ── what must not be carried ─────────────────────────────────────────
  {
    process.env.JWT_SECRET = "dev-account-key";

    check("no Authorization header carries nothing, and is not an error",
      captureSession(undefined) === null);
    check("  nor does a header that is not a Bearer token",
      captureSession("Basic bnVsbA==") === null);
    check("  nor does a token this app did not sign",
      captureSession("Bearer not.a.real.token") === null);

    // Signed with the right key, but already over. Switching accounts must not
    // be a way to get another eight hours out of a dead session.
    const jwt = (await import("jsonwebtoken")).default;
    const expired = jwt.sign({ ...USER, exp: Math.floor(Date.now() / 1000) - 60 },
      "dev-account-key", { algorithm: "HS256" });
    check("  nor an expired one, however it is presented",
      captureSession(`Bearer ${expired}`) === null,
      "a switch would have been a way to renew a dead session");
  }

  // ── the membership check needs an organization to check against ──────
  {
    const github = {
      GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret",
      GITHUB_APP_ID: "1", GITHUB_ORG: "Acme-Org",
    };
    for (const [k, v] of Object.entries(github)) process.env[k] = v;

    check("in an account holding GitHub credentials, membership is checkable",
      hasGithubCredentials() && membershipCheckable(),
      "a removed member must still be refused where there is an org to ask about");

    // uat: the secret holds nothing GitHub-shaped, so the reload cleared these.
    for (const k of Object.keys(github)) delete process.env[k];

    check("  in an account holding none, it is not",
      !hasGithubCredentials() && !membershipCheckable(),
      "there is no organization to ask about, so 'not a member' is not the answer");

    // The narrower case that actually bit: credentials present, org missing.
    // Asking anyway throws inside the check, which degrades to "not a member".
    for (const [k, v] of Object.entries(github)) process.env[k] = v;
    delete process.env.GITHUB_ORG;
    check("  and an account with credentials but no organization is not either",
      !membershipCheckable(),
      "getOrg() throws, and a throw must not read as a revoked membership");

    for (const k of Object.keys(github)) delete process.env[k];
  }

  // ── what the account you left must stop answering for ───────────────
  //
  // The switch endpoint reloading secrets is not the whole of a switch. Three
  // things in this process were cached because they "could not change" — a
  // DynamoDB client of the guardrail store's own, the home account id stamped
  // on every finding, and the gate's idea of which account this is. Each was
  // true only of an app that picked an account at launch.
  //
  // The bug they produced: the AWS tab showed whichever account was signed into
  // *first*, in both directions, and refreshing could not fix it because every
  // refresh asked the same stale client.
  {
    const fs = await import("fs");
    const path = await import("path");

    const { forgetAccountScopedCaches } = await import("./src/utils/awsAccountChange");
    let threw = false;
    try { await forgetAccountScopedCaches(); } catch { threw = true; }
    check("forgetting the account's caches runs without AWS", !threw);

    const resets: Array<[string, string]> = [
      ["src/aws-guardrails/store.ts", "resetGuardrailStore"],
      ["src/aws-guardrails/accounts.ts", "resetHomeAccountCache"],
      ["src/middleware/githubGate.ts", "resetGithubGate"],
    ];
    for (const [file, fn] of resets) {
      const mod = await import("./" + file.replace(/\.ts$/, ""));
      check(`  ${fn} is exported by ${path.basename(file)}`,
        typeof (mod as any)[fn] === "function");
    }

    // The list and the modules must not drift. Anything in the AWS half holding
    // a module-level cache has to be reset when the account changes, and the
    // way that gets missed is a new one being added a year from now.
    const collector = fs.readFileSync("src/utils/awsAccountChange.ts", "utf8");
    const dirs = ["src/aws-guardrails", "src/middleware"];
    const uncovered: string[] = [];
    for (const dir of dirs) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".ts")) continue;
        const file = path.join(dir, name);
        const body = fs.readFileSync(file, "utf8");
        // A module-level `let` in this half of the app is account-shaped state:
        // a client, an account id, a verdict about where we are.
        if (!/^let /m.test(body)) continue;
        const stem = name.replace(/\.ts$/, "");
        if (!collector.includes(`/${stem}"`)) uncovered.push(file);
      }
    }
    check("every module caching account-shaped state is reset on a switch",
      uncovered.length === 0, uncovered);
  }

  // ── and the switch has to actually ask for that ─────────────────────
  {
    const fs = await import("fs");
    const auth = fs.readFileSync("src/routes/auth.ts", "utf8");

    const helper = auth.slice(auth.indexOf("async function completeAwsSwitch"));
    check("the shared switch step forgets them",
      /forgetAccountScopedCaches\(\)/.test(helper.slice(0, 1200)));

    // Every endpoint that moves credentials must go through that step. Doing it
    // inline in three places is how two of them end up doing two of the three.
    for (const route of ["reconnect-aws", "aws-use-profile", "aws-access-keys"]) {
      const start = auth.indexOf(`"/${route}"`);
      const body = auth.slice(start, start + 2600);
      check(`  /${route} goes through it rather than reloading on its own`,
        /completeAwsSwitch\(carried\)/.test(body) && !/reloadSecretsIfNeeded\(\)/.test(body),
        route);
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
