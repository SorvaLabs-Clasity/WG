/**
 * Opening My work, without waiting for it to be computed.
 *
 * "It takes a while for the queue tab and the what did I ship tab and other
 * tabs to load." Three separate causes, and only one of them was the one that
 * looked obvious:
 *
 *   1. "What did I ship" is the only screen here whose answer is true of
 *      exactly one person, so it cannot come from the shared pull request walk
 *      the queue uses. Computing it pages the activity table two hundred rows
 *      at a time, filtering in memory, until it has four hundred of *that*
 *      person's. That happened while somebody waited, on every open.
 *
 *   2. Far worse, and invisible: `GET /api/me/alarms` reads a handful of small
 *      rows, and read the whole table to find them. That table also holds the
 *      stored answers, the pull request walk, the Dependabot sweep, every
 *      widget's rows, the Renovate views, hundreds of kilobytes each, and the
 *      scan pulled and parsed all of it so the caller could drop it one line
 *      later. Both "My alarms" and "My widgets" ask for it.
 *
 *   3. And the freshness windows were one constant shared by every stored view,
 *      so making the My work rows refresh on the half hour would have dragged
 *      the organization-wide Renovate searches to the half hour with them.
 *
 * What this pins is the shape of the answer rather than the timings: that the
 * stored row is served without waiting, that the person's name cannot become
 * an arbitrary storage key, that the scheduled pass warms only rows that
 * already exist, and that a scan asked for one kind of row does not fetch the
 * rest of the table.
 */
import fs from "node:fs";
import path from "node:path";
import {
  isViewFresh, isViewDue, FRESH_MS, __resetViews,
} from "./src/services/viewSnapshot";
import { shippedKey } from "./src/routes/me";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const SRC = path.join(__dirname, "src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf8");

/** Comments stripped, so a file that explains a bug is not accused of it. */
const code = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

(async () => {
  console.log("the My work rows refresh on the half hour, and the org-wide ones do not");
  {
    __resetViews();
    const now = Date.now();
    const at = (ms: number) => ({ computedAt: new Date(now - ms).toISOString() });
    const mine = shippedKey("Alice", 7);

    /**
     * Two different costs, so two different windows.
     *
     * The Renovate and Dependabot rows are organization-wide *searches*,
     * against the smallest budget GitHub gives, thirty requests a minute, so
     * the view leaves them to the scheduled pass and only acts when the pass
     * has clearly stopped. A My work row reads DynamoDB and nothing else, costs
     * no GitHub budget at all, and describes something that changes while
     * somebody is working, so it is refreshed sooner and the view is happy to
     * do it itself.
     */
    check("half an hour old is refreshed behind the reader",
      isViewDue(mine, at(31 * 60_000), now) === true);
    check("  twenty minutes old is left alone",
      isViewDue(mine, at(20 * 60_000), now) === false);

    check("  while the same age leaves an organization-wide row alone",
      isViewDue("renovate-prs", at(31 * 60_000), now) === false);
    check("  which still only recomputes once the pass has clearly stopped",
      isViewDue("renovate-prs", at(4 * 60 * 60_000), now) === true);

    // The scheduled pass uses the freshness window to decide what to skip, so
    // it has to move with the refresh window or the pass never warms these.
    check("the pass treats a My work row as stale after half an hour",
      isViewFresh(mine, at(31 * 60_000), now) === false);
    check("  and an organization-wide row only after an hour",
      isViewFresh("renovate-prs", at(31 * 60_000), now) === true
      && FRESH_MS === 60 * 60_000);

    // Nothing stored is a first open, which computes rather than serving stale.
    check("  nothing stored is not a refresh",
      isViewDue(mine, null, now) === false);
  }

  console.log("\nthe key is one row per person and window");
  {
    check("the person and the window are both in it",
      shippedKey("Alice", 7) === "shipped#alice#7", shippedKey("Alice", 7));

    // GitHub compares logins without case. Two rows for one person would each
    // be half as warm as one, and the pass would keep recomputing both.
    check("  and case does not make a second row",
      shippedKey("ALICE", 7) === shippedKey("alice", 7));

    check("  while a different window is a different row",
      shippedKey("alice", 7) !== shippedKey("alice", 30));
  }

  console.log("\na name that is not a name cannot become a row");
  {
    /**
     * `login` arrives as a query parameter and goes straight into a storage
     * key whose separator is `#`. Unchecked, a caller could write rows under
     * names that are not people's, and two people could be given one row.
     */
    const route = code(read("routes/me.ts"));
    check("the login is checked before it is used as a key",
      /\[A-Za-z0-9-\]\{1,39\}/.test(route), "GitHub logins are letters, digits and hyphens");
    check("  and a bad one is refused rather than stored",
      /not a GitHub username/.test(route));
  }

  console.log("\nthe stored answer is served without waiting for a fresher one");
  {
    const route = code(read("routes/me.ts"));

    // The whole point. A refresh in front of the reader is the behaviour this
    // replaces; the refresh has to start after the response has gone.
    const ship = route.slice(route.indexOf('router.get("/ship"'));
    const body = ship.slice(0, ship.indexOf("router.get(", 10));

    const sends = body.indexOf("res.json({ ...stored.data");
    const refreshes = body.indexOf("refreshViewIfDue");
    check("the row is sent before any refresh is started",
      sends !== -1 && refreshes !== -1 && sends < refreshes, { sends, refreshes });

    check("  and the refresh is not awaited", /void refreshViewIfDue/.test(body));

    // Read from the stored timestamp, not from anything this process
    // remembers: module state is wiped on every launch, and a window measured
    // from launch means the work starts again every time the app opens.
    check("  staleness is judged from the stored timestamp",
      /isViewDue\(key, stored\)/.test(body));

    check("  and the reader is told how old the answer is",
      /computedAt: stored\.computedAt/.test(body));
  }

  console.log("\nthe pass warms the rows that exist, and only those");
  {
    const handler = code(read("alarms/handler.ts"));
    const store = code(read("services/viewSnapshot.ts"));

    /**
     * A row exists because somebody opened the tab. Warming from a list of the
     * organization's members instead would do this work for hundreds of people
     * who never open it, every half hour, forever.
     */
    check("the pass looks up which My work rows are stored",
      /listViews\("shipped#"\)/.test(handler));
    check("  by key and timestamp only, not by payload",
      /project: "id, computedAt"/.test(store));

    check("  skipping the ones already fresh",
      /isViewFresh\(row\.kind, row\)/.test(handler));

    // A pass whose real job is alarms must not become a long walk through the
    // activity table because one organization has a lot of readers.
    check("  capped, so one large organization cannot take the pass over",
      /\.slice\(0, 40\)/.test(handler));
    check("  oldest first, so a capped pass does not starve the same rows",
      /computedAt\.localeCompare/.test(handler));

    // One person's row failing must not cost the other thirty-nine, and
    // warming anything must never cost a pass that has already sent alarms.
    check("  one row's failure does not stop the rest",
      /Could not refresh \$\{row\.kind\}/.test(handler));
    check("  and the whole warm-up cannot fail the pass",
      /Could not refresh the My work views/.test(handler));
  }

  console.log("\none builder, so the stored answer and the live one agree");
  {
    const route = code(read("routes/me.ts"));
    const handler = code(read("alarms/handler.ts"));

    // Two copies would be two places for the window arithmetic and the actor
    // re-check to drift, and the drift shows as an answer that changes
    // depending on which path happened to fill the row.
    check("the route exports the builder", /export async function buildShipped/.test(route));
    check("  and the pass uses that one", /buildShipped/.test(handler));
  }

  console.log("\nasking for a handful of rows does not read the whole table");
  {
    const alarms = code(read("services/alarmService.ts"));

    /**
     * The measured cause of the wait, and the one that never appeared in a log
     * line. This table holds the small rows these callers want *and* the
     * stored answers the rest of the app keeps in it: the pull request walk,
     * the Dependabot sweep, every widget's rows, the Renovate views. An
     * unfiltered scan pulled every one of those across the wire and parsed it
     * so that the next line could throw it away.
     *
     * `GET /api/me/alarms` is the one that made it visible: both "My alarms"
     * and "My widgets" ask for it on open.
     */
    check("the scan is told which kind of row is wanted",
      /async function allRecords\(kinds\?: readonly string\[\]\)/.test(alarms));
    check("  and asks DynamoDB for those, rather than filtering afterwards",
      /filter: `#k IN \(/.test(alarms));

    for (const [name, kind] of [
      ["listAlarms", "alarm"],
      ["listGroups", "group"],
      ["listPending", "pending"],
      ["readWidgetSnapshots", "widget-snapshot"],
      ["listPrStates", "pr-state"],
    ] as const) {
      check(`  ${name} asks for ${kind}`,
        new RegExp(`allRecords\\(\\["${kind}"\\]\\)`).test(alarms));
    }

    // Every caller. One left unfiltered still reads the whole table, and it
    // would be the one nobody thought to check.
    const unfiltered = (alarms.match(/allRecords\(\)/g) ?? []).length;
    check("  and no caller is left reading everything",
      unfiltered === 0, `${unfiltered} call(s) still pass no kind`);
  }

  console.log("\nthe open pull requests are listed in one place, not two");
  {
    /**
     * They were in both the queue and "What did I ship", which made the second
     * one a list of the same rows under a heading that implied they had gone
     * out. The queue is where an open pull request is actionable.
     */
    const page = code(fs.readFileSync(
      path.join(__dirname, "..", "frontend", "src", "pages", "MyWorkPage.tsx"), "utf8"));
    const shipped = page.slice(page.indexOf("function Shipped()"));
    const body = shipped.slice(0, shipped.indexOf("\nfunction ", 10));

    check("what shipped does not also list what has not",
      !/Still waiting|Still open/.test(body), "the queue is where an open pull request is acted on");

    // And the server stops computing it, rather than computing it and having
    // the page ignore it.
    const route = code(read("routes/me.ts"));
    const build = route.slice(route.indexOf("export async function buildShipped"));
    check("  and the route stops computing it",
      !/waiting/.test(build.slice(0, build.indexOf("\nrouter."))));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
