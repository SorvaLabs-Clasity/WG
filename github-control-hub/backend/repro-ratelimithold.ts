/**
 * A rate-limited permissions read must not be retried until the budget returns.
 *
 * Every failure was cached for five seconds, which is right for a broken file
 * and exactly wrong for an exhausted budget. Since the permissions file became
 * the enforcement switch, *every* request reads it — so the app retried a
 * rate-limited call every five seconds from every request and held its own
 * limit down. "No one is using the app and it is still rate limited" was the
 * app, using it.
 */
import { loadPermissions, forgetPermissions, isFailure } from "./src/permissions/store";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

process.env.GITHUB_ORG = "an-org";

let calls = 0;
let answer: { status: number; headers: Record<string, string>; body?: unknown } = {
  status: 200, headers: {},
};

const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any) => {
  const u = String(url);
  // Only the GitHub API is stubbed; the token manager's own calls are not
  // counted, because they are not what this measures.
  if (!u.includes("api.github.com")) return realFetch(url);
  calls++;
  return new Response(JSON.stringify(answer.body ?? { message: "API rate limit exceeded" }), {
    status: answer.status,
    headers: { "content-type": "application/json", ...answer.headers },
  });
};

async function main() {
  const { initTokenManager } = await import("./src/github/client");
  const stubAppAuth = () => async () => ({
    token: "ghs_app_token",
    expiresAt: new Date(Date.now() + 3600e3).toISOString(),
  });
  await initTokenManager("1", "key", "1", stubAppAuth as any);

  const resetAt = Math.floor(Date.now() / 1000) + 1800;

  console.log("a rate-limited read is held, not retried");
  {
    answer = {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
    };
    forgetPermissions();
    calls = 0;

    const first = await loadPermissions();
    check("the first read fails", isFailure(first) && first.reason === "unreachable", first);
    check("  and says the budget is the reason, with when it returns",
      isFailure(first) && /rate.?limit|refusing/i.test(first.detail)
        && typeof first.retryAfter === "number",
      isFailure(first) ? first.detail : first);
    check("  and accounts for a full budget on the rate-limit screen",
      isFailure(first) && /secondary/i.test(first.detail),
      "the screen reports the hourly budget; a burst trips a limit it never shows");

    const afterFirst = calls;

    /**
     * The thing that mattered: a burst of requests after the failure — which
     * is what every gated request now is — must not each ask GitHub again.
     * With a five-second TTL these all retried; the tenth one was still
     * retrying half an hour later.
     */
    for (let i = 0; i < 20; i++) await loadPermissions(Date.now() + i * 10_000);
    check("twenty later reads, spread over three minutes, ask GitHub nothing",
      calls === afterFirst, { afterFirst, now: calls });

    check("  and each still answers, rather than hanging or throwing",
      isFailure(await loadPermissions(Date.now() + 60_000)));
  }

  console.log("\nand the hold ends when the budget does");
  {
    answer = { status: 200, headers: {}, body: { message: "not json content" } };
    const past = (resetAt * 1000) + 1;
    calls = 0;
    await loadPermissions(past);
    check("a read after the reset time goes to GitHub again",
      calls > 0, calls);
  }

  console.log("\nan ordinary failure is not held that long");
  {
    answer = { status: 500, headers: {} };
    forgetPermissions();
    calls = 0;
    await loadPermissions();
    const afterFirst = calls;
    await loadPermissions(Date.now() + 10_000);
    check("a 500 is retried once the short failure TTL passes",
      calls > afterFirst,
      "holding every failure for half an hour would strand somebody repairing the file");
  }
  console.log("\nasking about somebody else is bounded by the teams that matter");
  {
    const { subjectFor, forgetSubjects } = await import("./src/permissions/subject");

    /**
     * Unbounded, this lists every team in the organization and asks a
     * membership question per team — one GitHub call per team, per person
     * inspected. An administrator clicking through twenty people in an
     * organization with thirty teams makes six hundred calls in a few seconds,
     * which is the burst that trips GitHub's secondary rate limit. Almost
     * always only a handful of teams can change the answer: the ones the
     * permissions file names, plus the admin team.
     */
    answer = { status: 404, headers: {}, body: { message: "Not Found" } };

    forgetSubjects();
    calls = 0;
    await subjectFor("someone-else", { relevantTeams: ["control-hub-admins", "platform"] });
    const bounded = calls;

    check("two relevant teams cost a bounded number of calls",
      bounded <= 4, bounded);

    forgetSubjects();
    calls = 0;
    await subjectFor("someone-else", { relevantTeams: ["control-hub-admins"] });
    check("  and one team costs fewer than two",
      calls < bounded, { one: calls, two: bounded });

    forgetSubjects();
    calls = 0;
    await subjectFor("someone-else", { relevantTeams: [] });
    check("  and no relevant teams asks nothing about teams at all",
      calls <= 1, calls);
  }

}

main().then(() => {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
