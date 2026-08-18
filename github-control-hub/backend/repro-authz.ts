/**
 * Tests for isControlHubAdmin.
 *
 * The failure modes that matter:
 *  - a plain org member must NOT be able to flip auto-apply
 *  - an org owner must always qualify, or a deleted/empty team locks everyone
 *    out of their own settings
 *  - a missing team must deny rather than throw
 *  - an API outage must deny, never fail open
 *
 * Stubs global fetch rather than createOctokit: the service imports that
 * statically, so an ESM binding cannot be reassigned from here. Going through
 * the HTTP layer also exercises real Octokit error shapes.
 */
process.env.GITHUB_ORG = "test-org";

import { isControlHubAdmin, isAwsAdmin, invalidateAdminCache, CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } from "./src/services/authorizationService";
import { initTokenManager, __resetTokenManagerForTests } from "./src/github/client";

/**
 * A GitHub App token, because that is now the only credential there is.
 *
 * This used to set SYSTEM_GITHUB_TOKEN and rely on getSystemToken() falling back
 * to it — convenient, and it quietly meant these tests never exercised the path
 * the app actually takes. That fallback has been removed, so the token manager
 * is stubbed instead, which is both closer to production and the only thing that
 * works now.
 */
const stubAppAuth = () => async () => ({
  token: "ghs_app_token",
  expiresAt: new Date(Date.now() + 3600e3).toISOString(),
});

type Scenario = {
  orgRole?: "admin" | "member";
  orgError?: number;
  teamState?: "active" | "pending";
  teamError?: number;
  /** Team slugs the user is an active member of, for the two-team tests. */
  memberOf?: string[];
};

let scenario: Scenario = {};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = (async (input: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/teams/")) {
    if (scenario.memberOf) {
      const slug = decodeURIComponent(url.split("/teams/")[1].split("/")[0]);
      return scenario.memberOf.includes(slug)
        ? json(200, { state: "active" })
        : json(404, { message: "Not Found" });
    }
    if (scenario.teamError) return json(scenario.teamError, { message: "team error" });
    return json(200, { state: scenario.teamState ?? "active" });
  }
  if (url.includes("/memberships/")) {
    if (scenario.orgError) return json(scenario.orgError, { message: "org error" });
    return json(200, { role: scenario.orgRole ?? "member", state: "active" });
  }
  return json(404, { message: "unexpected url: " + url });
}) as any;

(async () => {
  await initTokenManager("1", "key", "1", stubAppAuth as any);

  let failures = 0;
  const check = async (name: string, s: Scenario, expected: boolean) => {
    scenario = s;
    invalidateAdminCache();
    const got = await isControlHubAdmin("someone");
    const ok = got === expected;
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> expected ${expected}, got ${got}`));
    if (!ok) failures++;
  };

  await check("org owner is always admin, even with no team",
    { orgRole: "admin", teamError: 404 }, true);
  await check("member of the admin team is admin",
    { orgRole: "member", teamState: "active" }, true);
  await check("plain org member is NOT admin",
    { orgRole: "member", teamError: 404 }, false);
  await check("pending team invite does not count",
    { orgRole: "member", teamState: "pending" }, false);
  await check("team API failure fails closed",
    { orgRole: "member", teamError: 500 }, false);
  await check("org API failure still allows the team path",
    { orgError: 500, teamState: "active" }, true);
  await check("both APIs failing denies",
    { orgError: 500, teamError: 500 }, false);
  await check("non-member of the org is not admin",
    { orgError: 404, teamError: 404 }, false);

  // Caching must not leak one user's answer to another.
  scenario = { orgRole: "admin" };
  invalidateAdminCache();
  const adminAnswer = await isControlHubAdmin("owner-person");
  scenario = { orgRole: "member", teamError: 404 };
  const otherAnswer = await isControlHubAdmin("random-person");
  const cacheOk = adminAnswer === true && otherAnswer === false;
  console.log((cacheOk ? "  PASS  " : "  FAIL  ") + "cache is keyed per user"
    + (cacheOk ? "" : ` -> got ${adminAnswer}/${otherAnswer}`));
  if (!cacheOk) failures++;

  // ── the two teams are genuinely independent ─────────────────────────
  {
    const assert = (name: string, ok: boolean, got?: unknown) => {
      console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
      if (!ok) failures++;
    };
    const both = async (login: string) => {
      invalidateAdminCache();
      return [await isControlHubAdmin(login), await isAwsAdmin(login)];
    };

    assert("the two teams are not the same slug", CONTROL_HUB_ADMIN_TEAM !== AWS_ADMIN_TEAM,
      [CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM]);

    scenario = { orgRole: "member", memberOf: [CONTROL_HUB_ADMIN_TEAM] };
    let [gh, aws] = await both("github-only-person");
    assert("GitHub admin is NOT automatically an AWS admin", gh === true && aws === false, { gh, aws });

    scenario = { orgRole: "member", memberOf: [AWS_ADMIN_TEAM] };
    [gh, aws] = await both("aws-only-person");
    assert("AWS admin is NOT automatically a GitHub admin", gh === false && aws === true, { gh, aws });

    scenario = { orgRole: "member", memberOf: [CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM] };
    [gh, aws] = await both("both-person");
    assert("membership of both grants both", gh === true && aws === true, { gh, aws });

    scenario = { orgRole: "admin", memberOf: [] };
    [gh, aws] = await both("org-owner");
    assert("an org owner still gets both", gh === true && aws === true, { gh, aws });

    // The cache is keyed per team as well as per user, so one answer must not
    // stand in for the other.
    scenario = { orgRole: "member", memberOf: [AWS_ADMIN_TEAM] };
    invalidateAdminCache();
    const awsFirst = await isAwsAdmin("cache-person");
    const ghAfter = await isControlHubAdmin("cache-person");
    assert("cache does not leak one team's answer to the other", awsFirst === true && ghAfter === false,
      { awsFirst, ghAfter });
  }

  // ── the AWS team gates AWS, and nothing else ────────────────────────
  //
  // The two teams exist so that trusting somebody with GitHub settings is not
  // the same act as trusting them with an AWS account. That separation only
  // holds if the AWS check is used for AWS work — and it had spread to pull
  // request reminders, alarms, the dependency graph and the Renovate bot name,
  // so a member of the GitHub admin team could not change any of them without
  // also being an AWS admin. Nothing announced that; the buttons simply failed.
  //
  // Asserted against the routes as shipped, because the next person to need an
  // admin gate will copy whichever line they happen to read first.
  {
    const assert = (name: string, ok: boolean, got?: unknown) => {
      console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
      if (!ok) failures++;
    };
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "src", "routes");

    // Both write AWS: guardrails, and audit-log streaming, which creates IAM in
    // the account with the operator's own credentials.
    const MAY_USE_AWS_CHECK = new Set(["awsGuardrails.ts", "activity.ts", "auth.ts"]);

    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts") || MAY_USE_AWS_CHECK.has(file)) continue;
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      if (/\bisAwsAdmin\b/.test(src)) offenders.push(file);
    }
    assert("only AWS routes gate on the AWS admin team", offenders.length === 0,
      offenders.length ? `${offenders.join(", ")} gate GitHub work on aws-guardrail-admins` : "");

    // auth.ts reports both flags to the client and gates nothing, so it is
    // allowed the import — but it must not be quietly gating a route either.
    const authSrc = fs.readFileSync(path.join(dir, "auth.ts"), "utf8");
    assert("  and auth.ts only reports the AWS flag rather than gating on it",
      !/if\s*\(\s*!\s*\(?\s*await\s+isAwsAdmin/.test(authSrc));
  }

  // ── a broken App token is not an answer about the user ──────────────
  //
  // Membership is read with the App's own token, so no token means no answer.
  // That used to be cached as a plain `false` for the full TTL: a credential
  // problem lasting a moment kept every admin screen shut for a minute after it
  // healed, and told the person they were not an admin — which is a claim about
  // them rather than about the app.
  {
    const assert = (name: string, ok: boolean, got?: unknown) => {
      console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
      if (!ok) failures++;
    };

    invalidateAdminCache();
    scenario = { orgRole: "admin", memberOf: [] };

    __resetTokenManagerForTests();
    const duringOutage = await isControlHubAdmin("owner-person");
    assert("with no App token the check denies rather than throwing", duringOutage === false);

    // The token comes back. Without a cached denial in the way, the very next
    // call is correct — no waiting out a TTL.
    await initTokenManager("1", "key", "1", stubAppAuth as any);
    const afterRecovery = await isControlHubAdmin("owner-person");
    assert("  and the denial is not remembered once the token works",
      afterRecovery === true,
      "a cached no would have outlived the outage that caused it");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
