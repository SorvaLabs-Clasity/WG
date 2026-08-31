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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
