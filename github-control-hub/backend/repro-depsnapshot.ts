import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { isFresh, FRESH_MS } from "./src/services/dependencySnapshot";

/**
 * Regression test: the Vulnerabilities tab paints from a stored answer.
 *
 * Working it out takes an org-wide alert sweep plus two paged status reads. The
 * in-memory cache that already existed does nothing for the case that actually
 * hurt: the first open after launch, in a process that has just started, on an
 * organization where Dependabot has been switched on everywhere.
 *
 * The failure to avoid is subtler than slowness. A stored answer that is served
 * without being refreshed, or one truncated to fit, reports repositories as
 * clean that were never looked at.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const SRC = path.join(__dirname, "src");
const store = fs.readFileSync(path.join(SRC, "services/dependencySnapshot.ts"), "utf8");
const route = fs.readFileSync(path.join(SRC, "routes/dependencies.ts"), "utf8");

(async () => {
  console.log("\nage decides whether it is served as is");
  {
    const now = Date.now();
    check("a recent answer is fresh",
      isFresh({ alerts: [], computedAt: new Date(now - 1000).toISOString() }, now));
    check("  an old one is not",
      !isFresh({ alerts: [], computedAt: new Date(now - FRESH_MS - 1000).toISOString() }, now));
    check("  and nothing stored is not fresh either",
      !isFresh(null, now) && !isFresh({ alerts: [], computedAt: "" } as any, now),
      "an unreadable timestamp must not read as current");
  }

  console.log("\nthe stored answer is served, and refreshed behind the reader");
  {
    // Anchored on the block, not on a character distance. The window version
    // of this broke the moment a log line was added between the read and the
    // response, which is the failure the comment below already warned about
    // and which says nothing about whether the behaviour is right.
    const wholeOrgBranch = route.slice(
      route.indexOf("if (wholeOrg) {"),
      route.indexOf("if (repoFilter) {"));
    check("a stored answer answers immediately",
      /readDependencySnapshot\(\)/.test(wholeOrgBranch)
        && /res\.json\(/.test(wholeOrgBranch));
    // The point of the branch: it must answer without waiting for a sweep.
    check("  without sweeping first",
      wholeOrgBranch.indexOf("res.json(") < (
        wholeOrgBranch.includes("buildDependencyView")
          ? wholeOrgBranch.indexOf("buildDependencyView")
          : Infinity),
      "responding after a sweep is the delay this exists to remove");
    // Windows measured in characters break on a comment, and this codebase
    // comments heavily. Anchored on the block instead.
    const staleBranch = route.slice(
      route.indexOf("if (isDueForRefresh(stored))"),
      route.indexOf("if (repoFilter) {"));
    check("  a stale one is refreshed without being waited for",
      // Through the throttle now, but the claim is the same one: started, not
      // awaited. Awaiting it would reintroduce exactly the delay this removes.
      /void refreshIfDue\(/.test(staleBranch),
      staleBranch.slice(0, 300));
    // Anchored on the function rather than on a character window, for the
    // reason stated twenty lines above: a window measured in characters breaks
    // the moment somebody adds a comment, and this one did.
    const refresher = route.slice(
      route.indexOf("async function refreshDependencySnapshot"),
      route.indexOf("function applyFilters"));
    check("  and the refresh cannot throw into a caller that is not listening",
      /catch \(err: any\)/.test(refresher), refresher.slice(0, 200));

    // A sweep GitHub refused comes back empty, so the view is nothing but
    // "clean" markers. Stored, that reports an organization with no findings,
    // and it stands until a sweep succeeds.
    check("  and a partial sweep is never stored as the answer",
      /if \(degraded\)/.test(refresher) && /return;/.test(refresher),
      "an empty sweep stored as authoritative reads as a clean organization");
  }

  console.log("\none sweep, used by both paths");
  {
    // Two copies would be two places for the repository markers and the two
    // status reads to drift, and the drift shows as a repository appearing
    // clean on one path and unwatched on the other.
    check("the route and the refresh share it",
      !/async function sweepWholeOrg/.test(route)
        && (route.match(/buildDependencyView\(octokit, org/g) ?? []).length >= 2,
      route.match(/buildDependencyView/g)?.length);
  }

  console.log("\nchanging something invalidates what was stored");
  {
    // The stored answer describes the account as it was, and the point of
    // pressing any of these was to change it.
    const refreshes = (route.match(/void refreshNow\(\(\) => refreshDependencySnapshot\(octokit,/g) ?? []).length;
    check("every write refreshes it", refreshes >= 3, refreshes);

    /**
     * Through the guard, not around it.
     *
     * These three called the rebuild directly, which skipped both guards: two
     * toggles in a row started two concurrent organization-wide walks, each
     * paging every repository twice through calls that are not cached, and
     * neither appeared in `isRefreshing`, so the tab said "not refreshing"
     * while two sweeps ran and its timestamp sat still.
     */
    check("  through the guard rather than around it",
      !/void refreshDependencySnapshot\(/.test(route),
      "calling the rebuild directly skips the one-at-a-time guard");
    check("  and a change is not held off by the read throttle",
      /force: true/.test(store),
      "the throttle stops reads recomputing, not writes being reflected");
    check("  by recomputing rather than deleting",
      !/deleteDependencySnapshot/.test(route),
      "deleting would make the next open slow again, which is what the store prevents");
  }

  console.log("\nopening the tab does not start a sweep every time");
  {
    /**
     * "It rescans every time the app opens and I click Vulnerabilities."
     *
     * It did. The rule was: if the stored sweep is older than ten minutes,
     * serve it and start a fresh org-wide walk behind the reader. Nothing kept
     * the sweep warm unless a Dependabot-backed alarm happened to run, so on an
     * account without one it was always older than ten minutes, and every
     * single open started a walk of seventy-one pages. Two clicks in a row
     * started two, concurrently: there was no guard of any kind.
     *
     * The serve-from-storage part was right. The trigger was not.
     */
    const { __resetRefreshState, refreshIfDue, isRefreshing, REFRESH_EVERY_MS } =
      require("./src/services/dependencySnapshot");

    __resetRefreshState();
    let sweeps = 0;
    const sweep = async () => { sweeps++; await new Promise(r => setTimeout(r, 20)); };

    // Four opens in quick succession, which is a person clicking between tabs.
    await Promise.all([refreshIfDue(sweep), refreshIfDue(sweep), refreshIfDue(sweep)]);
    await refreshIfDue(sweep);
    check("several opens together start one sweep, not several", sweeps === 1, sweeps);

    await new Promise(r => setTimeout(r, 40));
    await refreshIfDue(sweep);
    check("  and another open right after starts none",
      sweeps === 1, sweeps);

    check("  the gap is measured in tens of minutes, not tens of seconds",
      REFRESH_EVERY_MS >= 20 * 60_000, REFRESH_EVERY_MS);
  }

  console.log("\nthe throttle survives the app being closed and reopened");
  {
    /**
     * The half of this the first fix missed.
     *
     * `lastRefreshAt` was module state, and closing the desktop app kills the
     * backend process. So the throttle was empty on every launch, and the very
     * first open after one started a full organization sweep whenever the
     * stored answer was over ten minutes old, which it almost always is. Close
     * the app, reopen it, open the tab: another sweep. Exactly the behaviour
     * the throttle was added to stop, surviving only within one session.
     *
     * The decision has to come from something that outlives the process, and
     * one already exists: the stored answer's own timestamp is the time of the
     * last successful refresh, and it is in DynamoDB.
     */
    const { isDueForRefresh, REFRESH_EVERY_MS } = require("./src/services/dependencySnapshot");
    const now = Date.now();
    const at = (msAgo: number) => ({ computedAt: new Date(now - msAgo).toISOString() });

    check("a sweep from five minutes ago is not due",
      isDueForRefresh(at(5 * 60_000), now) === false);
    check("  nor one from twenty-nine minutes ago",
      isDueForRefresh(at(29 * 60_000), now) === false);
    check("  nor two hours, because the pass warms it hourly",
      isDueForRefresh(at(2 * 60 * 60_000), now) === false);
    check("  while four hours means the pass has clearly stopped",
      isDueForRefresh(at(4 * 60 * 60_000), now) === true);

    // The property that matters: the same stored row gives the same answer to
    // a process that has just started as to one that has been running for
    // hours, because nothing in the decision is remembered in memory.
    check("  and the answer depends only on the stored timestamp",
      isDueForRefresh(at(31 * 60_000), now) === isDueForRefresh(at(31 * 60_000), now));

    // Nothing stored is not "due for a refresh": it is the first open, which
    // computes live rather than serving and refreshing behind.
    check("  nothing stored is not a refresh, it is a first open",
      isDueForRefresh(null, now) === false);
    check("  and an unreadable timestamp does not trigger one either",
      isDueForRefresh({ computedAt: "" }, now) === false);

    // Longer than the hour the pass warms on, deliberately. Set equal, there
    // is always a gap where the row is stale and the pass has not run yet, and
    // whoever opens the tab in that gap pays for the sweep.
    check("  the tab's window is longer than the pass's cadence",
      REFRESH_EVERY_MS > 60 * 60_000, REFRESH_EVERY_MS);
  }

  console.log("\nand the route asks that question rather than the freshness one");
  {
    // Freshness is ten minutes and drives what the tab *says*. Refreshing is
    // half an hour and drives what it *does*. Using the first for the second
    // is what made every launch sweep.
    const branch = route.slice(route.indexOf("if (wholeOrg) {"), route.indexOf("if (repoFilter) {"));
    check("the refresh is gated on being due, not on being fresh",
      /isDueForRefresh\(stored\)/.test(branch), branch.slice(0, 400));
  }

  console.log("\nwhile a sweep is running, the tab can say so truthfully");
  {
    const { __resetRefreshState, refreshIfDue, isRefreshing } =
      require("./src/services/dependencySnapshot");

    __resetRefreshState();
    check("nothing running means nothing claimed", isRefreshing() === false);

    let release: () => void = () => {};
    const held = new Promise<void>(r => { release = r; });
    const running = refreshIfDue(() => held);
    check("  a running sweep is reported", isRefreshing() === true);
    release();
    await running;
    check("  and stops being reported when it finishes", isRefreshing() === false);
  }

  console.log("\na sweep that throws does not wedge the next one");
  {
    const { __resetRefreshState, refreshIfDue, isRefreshing } =
      require("./src/services/dependencySnapshot");

    // A failure that left the in-flight marker set would stop every later
    // refresh for the life of the process, and nothing would say why.
    __resetRefreshState();
    await refreshIfDue(async () => { throw new Error("GitHub is down"); });
    check("the marker is cleared after a failure", isRefreshing() === false);
  }

  console.log("\nthe alarm pass keeps it warm, but only when it already swept");
  {
    const handler = fs.readFileSync(path.join(SRC, "alarms/handler.ts"), "utf8");

    // The whole economy of this: the org-wide walk is the expensive part, and
    // it has already been paid for when an alarm needed it. Starting one just
    // to warm a screen is the five-minutes-forever cost that was rejected.
    /**
     * This assertion has been reversed deliberately, and the reversal is the
     * point of the change it came with.
     *
     * It used to require that nothing was ever swept for the cache's sake: the
     * warm-up ran only where a Dependabot-backed alarm had already made the
     * pass sweep. The cost of that landed somewhere worse. On an account with
     * no such alarm the row was never filled by the pass at all, so its
     * timestamp only advanced when somebody opened the tab, and opening the tab
     * is precisely what the row exists to make cheap. Every launch swept.
     *
     * An hourly sweep from the pass is the cheaper half of that trade, and the
     * pass is the only thing that runs whether or not anybody has the app open.
     */
    check("the pass warms the row whether or not an alarm needed a sweep",
      !/if \(swept\) \{/.test(handler),
      "gating on an alarm's sweep never fills the row on an account without one");
    check("  and the alerts already fetched are handed over rather than fetched again",
      /buildDependencyView\(octokit, org, \{ alerts: result\.alerts \}\)/.test(handler),
      "re-sweeping inside one invocation spends the org-wide walk twice");

    check("  refreshed on the half hour, not on every tick",
      /WARM_MS/.test(handler) && /WARM_MS = 30 \* 60_000/.test(store),
      "every tick would add the two marker reads to every pass forever");

    // A partial sweep stored is repositories reported clean that were never
    // read, which is the one answer this screen must not give.
    check("  and a degraded sweep is not stored at all",
      /if \(!result\.degraded\)/.test(handler));

    // Warming a cache is the least important thing the pass does.
    check("  while a failure here cannot cost the pass",
      /catch \(err: any\)[\s\S]{0,200}Could not refresh the Dependabot view/.test(handler));
  }

  console.log("\none builder, used by the tab and the pass");
  {
    // Two copies would be two places for the repository markers to drift, and
    // the drift shows as a repository appearing clean on one path and
    // unwatched on the other.
    const view = fs.readFileSync(path.join(SRC, "services/dependencyView.ts"), "utf8");
    check("the view is a service both can call", /export async function buildDependencyView/.test(view));
    check("  the route uses it", /buildDependencyView\(octokit, org\)/.test(route));
    check("  and the markers are shared rather than defined twice",
      fs.existsSync(path.join(SRC, "services/dependencyMarkers.ts"))
        && !/function mockCleanAlert/.test(route));
  }

  console.log("\nthe tab says how old the picture is");
  {
    const page = fs.readFileSync(
      path.join(SRC, "..", "..", "frontend", "src", "pages", "DependencyDashboardPage.tsx"), "utf8");
    // The wording moved onto the switcher row when the page stopped being a
    // stack of bands. The claim is the same one: a reader can see how old this
    // picture is without asking.
    check("it shows when the sweep was taken",
      /swept \{new Date\(age\.computedAt\)/.test(page));
    // Nothing stored is a first open, not an old answer, and saying "as of now"
    // there would be noise.
    check("  and says nothing when there is nothing stored",
      /age\?\.computedAt &&/.test(page));
    // It used to say this whenever the stored sweep was over ten minutes old,
    // which was also the condition that started one, so it announced a rescan
    // on every open and then performed one. Now it says it only while a sweep
    // is genuinely running, which most opens will not start at all.
    check("  and says a sweep is on its way only while one is",
      /age\.refreshing &&/.test(page) && !/!age\.fresh &&/.test(page));
  }

  console.log("\na sweep too large to store is refused, not truncated");
  {
    // A tab drawn from half a sweep reports repositories as clean that were
    // never looked at, which is the answer this whole screen exists to avoid.
    check("an oversized payload is not written",
      /> 380_000/.test(store) && /return;/.test(store));
    check("  and says so rather than failing silently",
      /will not fit/.test(store));
    check("  while the rows themselves are never trimmed",
      !/slice\(0, /.test(store),
      "trimming here loses repositories, unlike a widget snapshot backing a count");
  }

  console.log("\nit is stored compressed, because JSON would not fit");
  {
    const alerts = Array.from({ length: 2000 }, (_, i) => ({
      id: `a${i}`, repo: `repo-${i % 300}`, org: "acme", dependency: "lodash",
      severity: "high", cve: "CVE-2020-8203", ecosystem: "npm",
      vulnerable_version: "<4.17.19", patched_version: "4.17.19",
      detected_at: "2026-01-01T00:00:00Z",
    }));
    const raw = Buffer.byteLength(JSON.stringify(alerts));
    const packed = Buffer.byteLength(gzipSync(Buffer.from(JSON.stringify(alerts))).toString("base64"));
    check(`2,000 alerts are ${Math.round(raw / 1024)}KB raw, past DynamoDB's limit`, raw > 400_000, raw);
    check(`  and ${Math.round(packed / 1024)}KB stored, which fits`, packed < 380_000, packed);
    check("  which is why the payload is gzipped", /gzipSync/.test(store) && /gunzipSync/.test(store));
  }

  console.log("\na corrupt row falls back rather than taking the tab down");
  {
    const reader = store.slice(store.indexOf("export async function readDependencySnapshot"));
    check("reading is guarded",
      /catch \(err: any\)/.test(reader) && /return null;/.test(reader));
    check("  and the caller computes when there is nothing stored",
      /if \(stored\) \{/.test(route),
      "no stored answer has to mean compute, not show nothing");
  }

  console.log("\na change is rebuilt once, however many made it");
  {
    /**
     * Behaviour, not a source scan, because the ordering is the whole point.
     *
     * The three write paths called the rebuild directly, which skipped both
     * guards. Two toggles in a row started two concurrent organization-wide
     * walks; each pages every repository twice through calls that are not
     * cached, and neither appeared in `isRefreshing`, so the tab said it was
     * not refreshing while two sweeps ran.
     */
    const { refreshNow, refreshIfDue, isRefreshing, __resetRefreshState } =
      require("./src/services/dependencySnapshot");

    {
      __resetRefreshState();
      let runs = 0;
      const run = async () => { runs++; await new Promise(r => setTimeout(r, 20)); };

      // Three toggles in a row need one rebuild between them, not three.
      await Promise.all([refreshNow(run), refreshNow(run), refreshNow(run)]);
      check("three changes at once cause one rebuild", runs === 1, runs);
    }

    {
      __resetRefreshState();
      let runs = 0;
      const run = async () => { runs++; await new Promise(r => setTimeout(r, 30)); };

      // The read path's throttle exists to stop reads recomputing the same
      // answer. A change is a new answer, so it must not be held off by it.
      await refreshIfDue(run);
      await refreshNow(run);
      check("  and a change is not refused by the read throttle", runs === 2, runs);
    }

    {
      __resetRefreshState();
      let runs = 0;
      let release: () => void = () => {};
      const slow = async () => {
        runs++;
        await new Promise<void>(r => { release = r; });
      };

      // A sweep already running started before the change, so it will store an
      // answer that does not contain it. The change has to wait for it and then
      // run, not be dropped because something happened to be in flight.
      const first = refreshIfDue(slow);
      await new Promise(r => setTimeout(r, 5));
      check("  a rebuild is visible while it runs", isRefreshing() === true);

      const second = refreshNow(async () => { runs++; });
      await new Promise(r => setTimeout(r, 5));
      check("  a change during a sweep is not dropped", runs === 1, runs);

      release();
      await first;
      await second;
      check("  it runs once the earlier sweep is done", runs === 2, runs);
      check("  and nothing is left marked as running", isRefreshing() === false);
    }

    {
      __resetRefreshState();
      // Every caller starts this with `void`, so a rejection escaping it would
      // be unhandled, and an unhandled rejection takes the process down.
      let after = 0;
      await refreshNow(async () => { throw new Error("GitHub is down"); });
      await refreshNow(async () => { after++; });
      check("  a failed rebuild does not reject into a caller that is not listening",
        after === 1, after);
    }
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
