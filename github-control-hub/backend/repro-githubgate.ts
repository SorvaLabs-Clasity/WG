/**
 * Confining the GitHub half of the app to one AWS account.
 *
 * An organization can reasonably want the AWS guardrails watching production
 * while everything to do with GitHub — the App's private key, the OAuth
 * secrets, the access graph, the activity log — exists only in a development
 * account. The desktop app reads its secrets from whichever account the
 * operator signed into, so nothing stopped somebody signing into production and
 * opening the Repos tab, which is a request for GitHub credentials in
 * production.
 *
 * The failures worth guarding:
 *
 *   - a gate that hides tabs but leaves the routes reachable, which is a
 *     suggestion rather than a restriction.
 *   - a gate that switches itself on, locking every existing install out of an
 *     app that worked yesterday.
 *   - an unreadable account counting as permission, which is the one case where
 *     "probably fine" is the wrong answer.
 *   - the AWS tab being caught by it, which would leave the account with
 *     nothing at all.
 */
import fs from "fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** The decision, lifted so it can be exercised without AWS. */
function verdict(configured: string, actual: string | null) {
  if (!configured) return { allowed: true, reason: "unrestricted" };
  if (!actual) return { allowed: false, reason: "unknown-account" };
  return actual === configured
    ? { allowed: true, reason: "match" }
    : { allowed: false, reason: "wrong-account" };
}

(async () => {
  // ── unset means the app people already have ─────────────────────────
  {
    check("with no account configured, everything is allowed",
      verdict("", "999999999999").allowed === true);
    check("  including when the account cannot be read at all",
      verdict("", null).allowed === true,
      "a gate nobody asked for must not lock anyone out");
  }

  // ── configured means confined ───────────────────────────────────────
  {
    check("the configured account is allowed", verdict("111111111111", "111111111111").allowed);
    check("  any other account is refused",
      verdict("111111111111", "222222222222").allowed === false);
    check("  and an unreadable account is refused, not waved through",
      verdict("111111111111", null).allowed === false,
      "asking for GitHub to be confined means unsure is not good enough");
  }

  // ── the routes are gated, not just the tabs ─────────────────────────
  //
  // Hiding a tab leaves the API reachable by anything that can talk to the
  // backend. Asserted against the server as shipped, because the next route
  // added will be mounted next to these.
  {
    const server = fs.readFileSync(`${__dirname}/src/server.ts`, "utf8");
    const mounts = [...server.matchAll(/app\.use\("(\/api\/[a-z]+)",([^)]*)\)/g)]
      .map(m => ({ path: m[1], mw: m[2] }));

    // Activity is the one deliberate exception: it carries both halves, and
    // locking it would remove the record of what the guardrails did in the very
    // accounts that run them. It filters itself instead — asserted below.
    const EXEMPT = new Set(["/api/aws", "/api", "/api/activity"]);
    const github = mounts.filter(m => !EXEMPT.has(m.path));
    const ungated = github.filter(m => !m.mw.includes("githubGateMiddleware"));
    check(`all ${github.length} GitHub routers are gated`, ungated.length === 0,
      ungated.map(m => m.path));

    // The AWS tab is the whole point of the exercise: it must work in the very
    // accounts the rest is refused in.
    const aws = mounts.find(m => m.path === "/api/aws");
    check("  the AWS router is not gated, so it works in every account",
      !!aws && !aws.mw.includes("githubGateMiddleware"));
    check("  and is still behind authentication",
      !!aws && aws.mw.includes("authMiddleware"));

    // Every gated router must still authenticate. A middleware inserted in the
    // wrong position could displace the one that matters.
    const unauthenticated = mounts.filter(m => m.path !== "/api" && !m.mw.includes("authMiddleware"));
    check("  every router still requires a signed-in user",
      unauthenticated.length === 0, unauthenticated.map(m => m.path));
  }

  // ── the refusal says what to do ─────────────────────────────────────
  {
    const src = fs.readFileSync(`${__dirname}/src/middleware/githubGate.ts`, "utf8");
    check("the refusal names the account it wants", /\$\{verdict\.expected\}/.test(src));
    check("  and the one you are in", /\$\{verdict\.account\}/.test(src));
    check("  and points at the tab that does work here", /AWS tab/.test(src));
    check("  under a code the frontend can branch on", /GITHUB_WRONG_ACCOUNT/.test(src));
  }

  // ── activity is filtered, not locked ────────────────────────────────
  //
  // Ungating a router is exactly where a hole hides: the list is only half of
  // it, and undo, redo and retry all *act* on a stored row. Undoing a branch
  // protection change from an account with no GitHub credentials is precisely
  // what the split exists to prevent.
  {
    const src = fs.readFileSync(`${__dirname}/src/routes/activity.ts`, "utf8");

    check("the feed drops GitHub rows when GitHub is not available here",
      /await awsOnly\(\)/.test(src) && /isAwsRow/.test(src));
    check("  filtered on the server, not hidden in the page",
      /allEntries = allEntries\.filter/.test(src),
      "these rows are who has access to what — an account not meant to hold them "
        + "is not meant to read them either");

    // Every route that acts on a row must refuse a GitHub one.
    const acting = [...src.matchAll(/router\.post\("\/:id\/([a-z-]+)"/g)].map(m => m[1]);
    const guards = [...src.matchAll(/refuseGithubRow\(res, entry\.action\)/g)].length;
    check(`  all ${acting.length} routes that act on a row check it first`,
      guards >= acting.length, { acting, guards });

    check("  and an AWS row stays actionable, since its guardrail still runs here",
      /if \(isAwsRow\(action\)\) return false;/.test(src));
  }

  // ── no credentials is enough on its own ─────────────────────────────
  //
  // The condition that needs no configuration, and the one most organizations
  // mean. Keeping GitHub out of an account is done by keeping GitHub's
  // credentials out of it — there is nothing to switch on, and so nothing to
  // forget to switch on.
  {
    const src = fs.readFileSync(`${__dirname}/src/middleware/githubGate.ts`, "utf8");
    check("an account with no GitHub credentials is refused without any configuration",
      /if \(!hasGithubCredentials\(\)\) return \{ allowed: false/.test(src));
    check("  checked before the configured-account rule, so it cannot be overridden by it",
      src.indexOf("hasGithubCredentials()") < src.indexOf("if (!GITHUB_ACCOUNT_ID)"));
    check("  and it needs all three, not any one of them",
      /GITHUB_CLIENT_ID[\s\S]{0,120}GITHUB_CLIENT_SECRET[\s\S]{0,120}GITHUB_APP_ID/.test(src));
  }

  // ── an AWS-only account is deployable and complete ──────────────────
  //
  // The half-install is only useful if it is a whole one of something: the
  // guardrails have to run, and the app has to be usable enough to see and
  // change them. A missing table or a missing credential turns "GitHub is not
  // here" into "nothing works here", which is a different and much worse claim.
  {
    const stack = fs.readFileSync(`${__dirname}/../infra/cdk-stack.ts`, "utf8");
    const script = fs.readFileSync(`${__dirname}/../../scripts/setup-aws-only.sh`, "utf8");

    check("the stack can leave the GitHub half uncreated", /if \(!awsOnly\) \{/.test(stack));
    check("  and the guardrail function is outside that block, so it is always built",
      stack.indexOf('new NodejsFunction(this, "GuardrailEnforcer"') < stack.indexOf("if (!awsOnly) {"));
    check("  as is its schedule",
      stack.indexOf('new events.Rule(this, "GuardrailSweep"') < stack.indexOf("if (!awsOnly) {"));

    check("the script deploys with the flag", /-c awsOnly=true/.test(script));

    // Every table the guardrail half and sign-in read must be created, or the
    // account deploys cleanly and fails at the first request.
    for (const t of ["aws-guardrails", "aws-exclusions", "aws-findings",
                     "activity", "org-config", "auth-codes"]) {
      check(`  it creates ${t}`, new RegExp(`\\b${t}\\b`).test(script));
    }

    // And the one credential that must not be here.
    check("the script never asks for the GitHub App private key",
      !/GH_PEM_PATH|GITHUB_APP_PRIVATE_KEY:/.test(script),
      "that key reads the whole organization — keeping it out is the point");
    check("  but it does warn when one is already stored",
      /already holds a GitHub App private key/.test(script));
    check("  and it does ask for what sign-in needs",
      /GITHUB_CLIENT_ID/.test(script) && /GITHUB_CLIENT_SECRET/.test(script)
        && /GITHUB_ORG/.test(script));
  }

  // ── the admin check works without a GitHub App ──────────────────────
  //
  // Sign-in is GitHub OAuth and the AWS tab is gated on GitHub team membership,
  // so an account with no App token would authenticate people and then refuse
  // all of them — an install that looks configured and can change nothing.
  {
    const src = fs.readFileSync(`${__dirname}/src/services/authorizationService.ts`, "utf8");
    check("team membership falls back to the caller's own token",
      /getSystemToken\(\) \|\| userToken/.test(src));
    check("  and only ever answers about the caller, which is what makes that safe",
      /asking about \*themselves\*/.test(src));

    const guardrails = fs.readFileSync(`${__dirname}/src/routes/awsGuardrails.ts`, "utf8");
    check("  the AWS routes pass it",
      /isAwsAdmin\(req\.user!\.login, req\.user!\.accessToken\)/.test(guardrails));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
