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

import fs from "node:fs";
import { isControlHubAdmin, isAwsAdmin, invalidateAdminCache, CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } from "./src/services/authorizationService";
import { initTokenManager, __resetTokenManagerForTests } from "./src/github/client";

/**
 * A GitHub App token, because that is now the only credential there is.
 *
 * This used to set SYSTEM_GITHUB_TOKEN and rely on getSystemToken() falling back
 * to it, convenient, and it quietly meant these tests never exercised the path
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

  /**
   * Owning the organization used to be sufficient, as a net against an empty
   * or deleted admin team. It meant somebody removed from that team kept full
   * access to the whole app, AWS included, with nothing able to explain it —
   * which from the inside reads as the permission system being broken.
   * Membership of the team is now the only way in.
   */
  await check("an org owner with no team membership is NOT admin",
    { orgRole: "admin", teamError: 404 }, false);
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
    assert("an org owner on neither team gets neither", gh === false && aws === false, { gh, aws });

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
  // holds if the AWS check is used for AWS work, and it had spread to pull
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

    // All of these consult the AWS admin check: guardrails; the activity
    // router, whose detailed-logging settings are gated on it; and the config
    // import, whose bundle carries an `awsGuardrails` section that goes to the
    // same store the /api/aws routes own. That last one is the reason this set
    // is a set rather than one name, an import was a way to create an
    // enforcing guardrail while only ever proving membership of the *GitHub*
    // admin team, which is precisely the separation this block exists to keep.
    const MAY_USE_AWS_CHECK = new Set([
      "awsGuardrails.ts", "activity.ts", "auth.ts", "config.ts",
      // Alarms hold both kinds. A guardrail alarm watches AWS findings and
      // belongs to the AWS team; a widget alarm does not and must not. Being on
      // this list buys the file nothing on its own — the assertion below is what
      // holds the separation, and it is stricter than exclusion would be.
      "alarms.ts",
      // Not a gate at all, same as `auth.ts` above: `isAwsAdmin` here is a
      // field on `MemberSnapshot`, reporting who is on the legacy AWS team so
      // the migration can reproduce it as a preset. Every route in this file
      // is gated by `requirePermission`, never by team membership.
      "admin.ts",
    ]);

    const offenders: string[] = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".ts") || MAY_USE_AWS_CHECK.has(file)) continue;
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      if (/\bisAwsAdmin\b/.test(src)) offenders.push(file);
    }
    assert("only AWS routes gate on the AWS admin team", offenders.length === 0,
      offenders.length ? `${offenders.join(", ")} gate GitHub work on aws-guardrail-admins` : "");

    /**
     * And in the one file that holds both, the AWS check is reached only for
     * AWS subjects.
     *
     * This is the separation the block above exists for, stated positively
     * rather than by exclusion: a widget alarm must never require the AWS team,
     * and an AWS alarm must never be satisfied by the GitHub one.
     */
    const alarmsSrc = fs.readFileSync(path.join(dir, "alarms.ts"), "utf8");
    const decider = /const aws = subjectId\.startsWith\(GUARDRAIL_PREFIX\);/.test(alarmsSrc);
    assert("  and in alarms.ts the subject decides which team", decider,
      decider ? "" : "the two teams would be interchangeable for every alarm");

    const branch = /\? await isAwsAdmin\([\s\S]{0,80}: await isControlHubAdmin\(/.test(alarmsSrc);
    assert("    AWS subjects to the AWS team, everything else to the Control Hub one",
      branch, branch ? "" : "one team could claim the other's alarms");

    // The blanket read gate admits either, which is a weaker claim on purpose:
    // an admin who cannot see an alarm cannot be told they may change it.
    const readOnlyEither = /Promise\.all\(\[[\s\S]{0,200}isControlHubAdmin[\s\S]{0,200}isAwsAdmin/
      .test(alarmsSrc);
    assert("    while reading is open to either", readOnlyEither,
      readOnlyEither ? "" : "reading should not be narrower than writing");

    // auth.ts reports both flags to the client and gates nothing, so it is
    // allowed the import, but it must not be quietly gating a route either.
    const authSrc = fs.readFileSync(path.join(dir, "auth.ts"), "utf8");
    assert("  and auth.ts only reports the AWS flag rather than gating on it",
      !/if\s*\(\s*!\s*\(?\s*await\s+isAwsAdmin/.test(authSrc));
  }

  // ── a broken App token is not an answer about the user ──────────────
  //
  // Membership is read with the App's own token, so no token means no answer.
  // That used to be cached as a plain `false` for the full TTL: a credential
  // problem lasting a moment kept every admin screen shut for a minute after it
  // healed, and told the person they were not an admin, which is a claim about
  // them rather than about the app.
  {
    const assert = (name: string, ok: boolean, got?: unknown) => {
      console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
      if (!ok) failures++;
    };

    invalidateAdminCache();
    // On the team, so recovery is observable: an owner off the team is denied
    // whether or not the token works, which would make the assertion below
    // pass for the wrong reason.
    scenario = { orgRole: "member", memberOf: [CONTROL_HUB_ADMIN_TEAM] };

    __resetTokenManagerForTests();
    const duringOutage = await isControlHubAdmin("owner-person");
    assert("with no App token the check denies rather than throwing", duringOutage === false);

    // The token comes back. Without a cached denial in the way, the very next
    // call is correct, no waiting out a TTL.
    await initTokenManager("1", "key", "1", stubAppAuth as any);
    const afterRecovery = await isControlHubAdmin("owner-person");
    assert("  and the denial is not remembered once the token works",
      afterRecovery === true,
      "a cached no would have outlived the outage that caused it");
  }

  /**
   * Why, and not only whether.
   *
   * Reported as: "I removed myself from both teams and still have full access,
   * all the permissions are out of wack." They were not. An organization owner
   * passes every check here whatever team they are on, deliberately, so that a
   * deleted or empty team cannot lock everyone out of their own settings — and
   * the only visible effect of leaving both teams was nothing happening at all.
   * From the inside that is indistinguishable from a gate that does not work.
   *
   * The rule stays. What changes is that the answer carries the route, and the
   * app says it, so a working gate can be told from a broken one without
   * reading the source.
   */
  console.log("\nthe answer says how, not only whether");
  {
    /**
     * A plain source assertion, and deliberately not the `check` above: that
     * one runs a *scenario* through the real resolver and is async. Passing a
     * boolean to it silently reads as a Scenario, the await is missing, and the
     * assertion neither runs nor reports — which is exactly what happened on
     * the first attempt at this block, printing a heading with nothing under
     * it.
     */
    const claim = (name: string, ok: boolean, why?: string) => {
      console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> ${why ?? "no"}`));
      if (!ok) failures++;
    };

    const svc = fs.readFileSync("src/services/authorizationService.ts", "utf8");

    /**
     * The route is still reported rather than a bare yes — that is what stopped
     * a deliberate rule reading as a broken one. What changed is that there is
     * only one route left: ownership confers nothing, so "owner" is never
     * returned and the answer is team membership or nothing.
     */
    claim("the answer says how, not merely yes",
      /export type AdminVia/.test(svc) && /\? "team" : null/.test(svc),
      "a bare boolean is what made a deliberate rule look like a broken one");
    claim("  and ownership is no longer one of the ways",
      !/return "owner";/.test(svc),
      "owning the organization silently conferred every permission in the app");
    claim("  and team membership as team membership",
      /\? "team" : null/.test(svc));
    claim("  while the boolean the gates use is unchanged",
      /export async function isAwsAdmin[\s\S]{0,160}!!\(await adminVia\(/.test(svc),
      "this must not become a second, differently-behaved gate");

    // Unanswerable stays unanswerable: a broken App token is not a denial, and
    // caching it as one locks somebody out for the full TTL after it heals.
    claim("  and an unreadable answer is still not a denial, and still uncached",
      /if \(err instanceof Unanswerable\) return null;/.test(svc));

    const route = fs.readFileSync("src/routes/auth.ts", "utf8");
    const perms = route.slice(route.indexOf('router.get("/permissions"'));
    const body = perms.slice(0, perms.indexOf("\nrouter."));
    claim("the endpoint sends the route for both teams",
      /controlHubAdminVia: github/.test(body) && /awsAdminVia: aws/.test(body));
    claim("  and still sends the plain verdict beside it",
      /isControlHubAdmin: !!github/.test(body) && /isAwsAdmin: !!aws/.test(body),
      "every existing caller reads the boolean");

    const nav = fs.readFileSync("../frontend/src/components/Navbar.tsx", "utf8");
    claim("and the app says it where somebody is looking for it",
      /function AdminStanding/.test(nav) && /Organization owner\./.test(nav)
      && /leaving\s*\n?\s*those teams changes nothing for you/.test(nav));
    claim("  reading the same cached answer the gates read",
      /usePermissions\(\)/.test(nav.slice(nav.indexOf("function AdminStanding"))),
      "a second source here is a line that can disagree with the tabs");
    claim("  and saying nothing rather than guessing on an older backend",
      /controlHubAdminVia === undefined && perms\.awsAdminVia === undefined/.test(nav));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
