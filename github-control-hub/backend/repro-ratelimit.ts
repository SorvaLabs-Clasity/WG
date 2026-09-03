/**
 * Not asking GitHub the same question several times a minute.
 *
 * The two org-wide reads here are the ones that trip a **secondary** rate
 * limit, which is not the hourly budget but "too much, too fast": the
 * Dependabot alert sweep pages a hundred at a time, and the Renovate search
 * draws on the search API, whose limit is thirty requests a *minute*, the
 * smallest budget the app has.
 *
 * Both were memoised inside the alarm pass and nowhere else, so the pass was
 * careful and every page load was not. A person clicking around the
 * Vulnerabilities tab, with widgets computing live beside them, issues exactly
 * the burst that limit exists to stop.
 *
 * Run:  npx tsx repro-ratelimit.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { fetchOrgDependencyAlerts, invalidateDependencySweep } from "./src/services/dependencyService";
import { fetchRenovatePrs, invalidateRenovateSearch } from "./src/services/renovateService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── the Dependabot sweep ────────────────────────────────────────────
  {
    let pages = 0;
    const octokit: any = { rest: { dependabot: {
      listAlertsForOrg: async () => { pages++; return { data: [], headers: {} }; },
    } } };

    invalidateDependencySweep();
    pages = 0;
    await Promise.all(Array.from({ length: 6 }, () => fetchOrgDependencyAlerts(octokit, "acme")));
    check("six callers at once cost one sweep", pages === 1, pages);

    pages = 0;
    await fetchOrgDependencyAlerts(octokit, "acme");
    await fetchOrgDependencyAlerts(octokit, "acme");
    check("  and repeats within the window cost none", pages === 0, pages);

    invalidateDependencySweep();
    pages = 0;
    await fetchOrgDependencyAlerts(octokit, "acme");
    check("  while an invalidated cache goes back to GitHub", pages === 1, pages);

    // A different organization is a different question.
    pages = 0;
    await fetchOrgDependencyAlerts(octokit, "other-org");
    check("  and another organization is not served the first one's answer",
      pages === 1, pages);
  }

  // ── a failed sweep is not held ──────────────────────────────────────
  //
  // "We could not read this" cached for a minute turns one failed request into
  // a minute of them, and hides a token whose scope was just fixed.
  {
    let calls = 0;
    const failing: any = { rest: { dependabot: {
      listAlertsForOrg: async () => {
        calls++;
        const e: any = new Error("Forbidden"); e.status = 403; throw e;
      },
    } } };

    invalidateDependencySweep();
    const a = await fetchOrgDependencyAlerts(failing, "acme");
    const b = await fetchOrgDependencyAlerts(failing, "acme");
    check("a degraded sweep says so", a.degraded === true, a);
    check("  and is asked again rather than held", calls === 2, calls);
  }

  // ── the Renovate search ─────────────────────────────────────────────
  {
    let searches = 0;
    const search = async () => { searches++; return { items: [] }; };

    invalidateRenovateSearch();
    searches = 0;
    await Promise.all(Array.from({ length: 5 },
      () => fetchRenovatePrs(search as any, "acme", "renovate[bot]")));
    const concurrent = searches;
    check("five callers at once cost one search pass", concurrent <= 2, concurrent);

    searches = 0;
    await fetchRenovatePrs(search as any, "acme", "renovate[bot]");
    await fetchRenovatePrs(search as any, "acme", "renovate[bot]");
    check("  and repeats within the window cost none", searches === 0, searches);

    // Without this, five callers is five times whatever one call costs, and one
    // call is already several requests: it pages, and tries each candidate
    // spelling because search answers an unknown author with 422.
    check("  which is what a page load beside an alarm pass looks like",
      concurrent < 5, { concurrent });
  }

  // ── the widget that made this urgent ────────────────────────────────
  //
  // `repos-dependent-on` was changed to read live alerts so it and the
  // Vulnerabilities tab could not disagree. That is right, and it put a fourth
  // caller on an uncached org-wide sweep.
  {
    const gs = fs.readFileSync("./src/services/graphService.ts", "utf8");
    check("the package query goes through the shared sweep",
      /fetchOrgDependencyAlerts/.test(gs),
      "a private copy of the sweep is a private copy of the rate limit");

    const dep = fs.readFileSync("./src/services/dependencyService.ts", "utf8");
    check("  and the sweep is cached for every caller, not per caller",
      /let sweepCache/.test(dep) && /let sweepInFlight/.test(dep),
      "memoising inside one pass leaves every other caller unprotected");

    const ren = fs.readFileSync("./src/services/renovateService.ts", "utf8");
    check("  as is the search",
      /let renovateCache/.test(ren) && /let renovateInFlight/.test(ren),
      "search is thirty requests a minute, the smallest budget here");
  }

  })();

/**
 * ── Which limit, not just that there was one ──────────────────────────────
 *
 * "I keep getting the slow-down message even though the requests tab says I
 * have used 8 requests." Both were true, and the message was the thing at
 * fault. GitHub keeps three separate budgets in different units: core at
 * 15,000 an hour, GraphQL at 5,000 points an hour, and search at **thirty a
 * minute**. Thirty a minute is small enough to spend twice over inside one
 * minute of an hour whose total reads 8.
 *
 * The refusal says which budget it was, in `x-ratelimit-resource`, and this
 * code was throwing that header away and then describing every primary limit
 * as "the hourly request budget for this organization is spent". For a search
 * limit that is wrong twice: wrong budget, wrong unit, and it sends somebody
 * to a screen showing hourly totals that will never explain it.
 */
import { parseRateLimit as parse, describeRateLimit } from "./src/utils/rateLimit";

function limitErr(headers: Record<string, string>, message = "API rate limit exceeded") {
  return Object.assign(new Error(message), { status: 403, response: { headers } });
}

console.log("\nwhich budget was spent, not just that one was");
{
  const search = parse(limitErr({
    "x-ratelimit-remaining": "0", "x-ratelimit-limit": "30",
    "x-ratelimit-resource": "search", "x-ratelimit-reset": "1700000000",
  }));
  check("a search limit is reported as the search budget", search?.resource === "search", search);
  // It may mention the hourly budget to contrast with it. What it must never
  // do is describe the search allowance itself as the hourly one, which is the
  // sentence that sent somebody to a screen that could not explain it.
  check("  and described in minutes, because that is its unit",
    /per minute/i.test(describeRateLimit(search!))
      && !/hourly request budget/i.test(describeRateLimit(search!)),
    describeRateLimit(search!));

  const core = parse(limitErr({
    "x-ratelimit-remaining": "0", "x-ratelimit-limit": "15000",
    "x-ratelimit-resource": "core", "x-ratelimit-reset": "1700000000",
  }));
  check("  a core limit still reads as the hourly budget",
    core?.resource === "core" && /hour/i.test(describeRateLimit(core!)), describeRateLimit(core!));

  const graphql = parse(limitErr({
    "x-ratelimit-remaining": "0", "x-ratelimit-limit": "5000", "x-ratelimit-resource": "graphql",
  }));
  check("  and GraphQL is named as points rather than requests",
    graphql?.resource === "graphql" && /point/i.test(describeRateLimit(graphql!)),
    describeRateLimit(graphql!));
}

console.log("\nan unnamed budget is not guessed at");
{
  // Older responses and some proxies omit the header. Naming a budget nobody
  // reported would be a confident wrong answer, which is worse than a vague
  // right one, so the wording stays general.
  const unnamed = parse(limitErr({ "x-ratelimit-remaining": "0", "x-ratelimit-limit": "15000" }));
  check("no resource header leaves the resource unset", unnamed?.resource === undefined, unnamed);
  check("  and the description does not claim which budget it was",
    !/search|graphql/i.test(describeRateLimit(unnamed!)), describeRateLimit(unnamed!));
}

console.log("\nsecondary limits are still secondary, whatever the budget");
{
  const secondary = parse(limitErr({
    "retry-after": "37", "x-ratelimit-remaining": "4321", "x-ratelimit-resource": "core",
  }, "You have exceeded a secondary rate limit"));
  check("too much too fast is not the budget running out",
    secondary?.kind === "secondary" && secondary?.retryAfter === 37, secondary);
  check("  and it says how long, because GitHub told us",
    /37/.test(describeRateLimit(secondary!)), describeRateLimit(secondary!));
}

console.log("\na refusal that is not about rate at all is left alone");
{
  check("a permission 403 is not a rate limit",
    parse(Object.assign(new Error("Resource not accessible by integration"),
      { status: 403, response: { headers: { "x-ratelimit-remaining": "4999" } } })) === null);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
