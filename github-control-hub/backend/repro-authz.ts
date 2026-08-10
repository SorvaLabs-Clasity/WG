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
process.env.SYSTEM_GITHUB_TOKEN = "ghp_system";

import { isControlHubAdmin, isAwsAdmin, invalidateAdminCache, CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } from "./src/services/authorizationService";

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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
