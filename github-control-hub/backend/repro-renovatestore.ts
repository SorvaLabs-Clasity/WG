/**
 * Keeping the Renovate views in the cloud instead of computing them on open.
 *
 * "It takes so long to load." It did. Both halves cost a search against the
 * thirty-requests-a-minute budget, the smallest GitHub gives, and the dashboard
 * half then parses an issue body per repository. All of that happened while
 * somebody waited, on every open, and spent that budget every time.
 *
 * Stored now, and filled by the alarm pass, which is the only thing that runs
 * without the app being open. The rules are the ones the Dependabot sweep
 * beside it already settled, and they are here because each was learned from a
 * specific failure:
 *
 *   - refuse an oversized payload rather than truncate it, because half a
 *     sweep reports repositories as having nothing pending when nobody looked
 *   - a failed save is reported, because a silent one is a view that is slow
 *     forever with no visible cause
 *   - refreshes are throttled and deduplicated, because otherwise every open
 *     of a stale view starts a fresh org-wide search and two opens start two
 */
import fs from "node:fs";
import path from "node:path";
import {
  isRenovateFresh, refreshRenovateIfDue, isRenovateRefreshing,
  __resetRenovateSnapshots, FRESH_MS,
} from "./src/services/renovateSnapshot";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const SRC = path.join(__dirname, "src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");

(async () => {
  console.log("an hour old is still served, and nothing older is trusted silently");
  {
    const now = Date.now();
    check("just computed is fresh",
      isRenovateFresh({ computedAt: new Date(now - 60_000).toISOString() }, now));
    check("  an hour and a half is not",
      !isRenovateFresh({ computedAt: new Date(now - 90 * 60_000).toISOString() }, now));
    check("  the window is the hour that was asked for",
      FRESH_MS === 60 * 60_000, FRESH_MS);

    // An unreadable timestamp must not read as current: it is the direction
    // that makes a stale answer look live.
    check("  and a missing or broken timestamp is never fresh",
      !isRenovateFresh(null, now) && !isRenovateFresh({ computedAt: "" }, now));
  }

  console.log("\nopening the view does not start a search every time");
  {
    __resetRenovateSnapshots();
    let runs = 0;
    const run = async () => { runs++; await new Promise(r => setTimeout(r, 10)); };

    await Promise.all([
      refreshRenovateIfDue("renovate-prs", run),
      refreshRenovateIfDue("renovate-prs", run),
      refreshRenovateIfDue("renovate-prs", run),
    ]);
    check("three opens together start one search", runs === 1, runs);

    await refreshRenovateIfDue("renovate-prs", run);
    check("  and another open right after starts none", runs === 1, runs);

    // The two rows are refreshed independently: the cheap view must not be
    // held back by the expensive one's throttle.
    await refreshRenovateIfDue("renovate-dashboards", run);
    check("  while the other row is throttled on its own", runs === 2, runs);
  }

  console.log("\na search that fails does not wedge the next one");
  {
    __resetRenovateSnapshots();
    await refreshRenovateIfDue("renovate-prs", async () => { throw new Error("GitHub is down"); });
    check("the in-flight marker is cleared", isRenovateRefreshing("renovate-prs") === false);
  }

  console.log("\nthe view refreshes only when the pass has clearly stopped");
  {
    /**
     * The relationship that was the wrong way round.
     *
     * The pass warms these rows hourly and the view refreshed anything past its
     * one-hour freshness window, so there was always a gap where the stored
     * answer was stale and the pass had not run yet, and whoever opened the
     * view in that gap paid for the search. Every open, in practice.
     *
     * The view's window has to be longer than the pass's cadence, so that it
     * only acts when the pass has stopped rather than merely not run yet.
     */
    const { isRenovateDueForRefresh } = require("./src/services/renovateSnapshot");
    const now = Date.now();
    const at = (ms: number) => ({ computedAt: new Date(now - ms).toISOString() });

    check("an hour old is served without recomputing",
      isRenovateDueForRefresh(at(61 * 60_000), now) === false);
    check("  two hours is still not the view's job",
      isRenovateDueForRefresh(at(2 * 60 * 60_000), now) === false);
    check("  and at four hours the pass has clearly stopped",
      isRenovateDueForRefresh(at(4 * 60 * 60_000), now) === true);

    // Longer than the hour the pass warms on, which is the whole property.
    check("  the view's window is longer than the pass's cadence",
      !isRenovateDueForRefresh(at(FRESH_MS + 60_000), now), FRESH_MS);

    // Nothing stored is a first open, which computes rather than serving stale.
    check("  and nothing stored is not a refresh",
      isRenovateDueForRefresh(null, now) === false);
  }

  console.log("\nthe Dependabot tab makes no live GitHub call either");
  {
    const route = read("routes/dependencies.ts");
    const handler = read("alarms/handler.ts");

    // The last one it made: a search on the thirty-a-minute budget plus a
    // GraphQL batch per fifty pull requests, on every single open.
    check("the pull request counts are stored too",
      /readRenovateSnapshot<any>\("dependabot-prs"\)/.test(route));
    check("  and filled by the same hourly pass",
      /saveRenovateSnapshot\("dependabot-prs"/.test(handler));
  }

  console.log("\nthe pass warms the Dependabot view whether or not an alarm needed it");
  {
    const handler = read("alarms/handler.ts");

    /**
     * It used to run only when a Dependabot-backed alarm had already swept, so
     * nothing was swept for the cache's sake. On an account with no such alarm
     * the row was never filled here at all, so its timestamp only advanced when
     * somebody opened the tab, which is the thing it was meant to make cheap.
     */
    check("the warm-up is not gated on an alarm having swept",
      !/if \(swept\) \{/.test(handler), "gating on `swept` never fills the row without an alarm");

    // But a pass that did sweep must not sweep twice for identical data.
    check("  while a sweep the pass already made is reused",
      /swept \?\? fetchOrgDependencyAlerts\(octokit, org\)/.test(handler));

    check("  still hourly rather than every pass", /WARM_MS/.test(handler));
    check("  and a degraded sweep is still never stored", /!result\.degraded/.test(handler));
  }

console.log("\nthe pass that runs without the app open is what fills it");
  {
    const handler = read("alarms/handler.ts");

    // Nothing else runs on a schedule, so without this the rows are only ever
    // filled by somebody opening the tab, which is the thing being avoided.
    check("the alarm pass warms both rows",
      /renovate-prs/.test(handler) && /renovate-dashboards/.test(handler));
    check("  only when the stored one is not already fresh",
      /isRenovateFresh\(stored\)\) continue/.test(handler));
    check("  and only where a bot is configured",
      /if \(bot\)/.test(handler));

    // Warming a view is the least important thing the pass does.
    check("  while a failure here cannot cost the pass",
      /Could not refresh the Renovate views/.test(handler));
  }

  console.log("\none builder, so the stored answer and the live one agree");
  {
    const route = read("routes/dependencies.ts");
    const handler = read("alarms/handler.ts");

    // Two copies would be two places for the bot-name resolution and the
    // detail enrichment to drift, and the drift shows as a view that changes
    // what it says depending on which path filled it.
    check("the pass and the route share the pull request builder",
      /export async function buildRenovatePrs/.test(route)
        && /buildRenovatePrs/.test(handler));
    check("  and the dashboard builder",
      /export async function buildRenovateDashboards/.test(route)
        && /buildRenovateDashboards/.test(handler));
  }

  console.log("\nthe bot's login is resolved, not assumed");
  {
    const svc = read("services/renovateDashboards.ts");

    /**
     * The bug this file was written after: `author:` wants the exact login,
     * and a GitHub App's is `<name>[bot]`, a suffix GitHub's UI hides. Asking
     * for the wrong spelling is answered with 422, which surfaced as "could
     * not read the renovate dashboards" on an organization whose dashboards
     * were all present.
     */
    check("both spellings are tried", /botCandidates/.test(svc));
    check("  an unknown author is its own state, not a failure",
      /unknownBot: true/.test(svc));
    check("  and any other error is still raised rather than retried blindly",
      /if \(status !== 422\) throw err/.test(svc));

    // The pull request search has resolved this since it was written. Sharing
    // it is what stops the two drifting again.
    check("  using the same resolution the pull request search uses",
      /from "\.\/renovateService"/.test(svc));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
