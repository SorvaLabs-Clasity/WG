/**
 * The Security tab, after it stopped contradicting itself.
 *
 * The bug that caused the rebuild: the tab had two views behind a toggle. The
 * "Overview" summarised **every** alert, and "Every alert" listed only the
 * **unresolved** ones, because its filter defaulted to "active". On an
 * organization that had dealt with everything — seventeen alerts, all
 * resolved — the overview showed seventeen things and the list showed none.
 * Both were behaving exactly as written.
 *
 * So the assertions below are mostly about that shape: one list, one filter
 * state, and a default that cannot hide what the page has just finished
 * summarising.
 */
import * as fs from "node:fs";
import {
  toSituations, weeklyActivity, summarizeKinds, summarizeRepos, recent, wasReverted,
  type AlertLike,
} from "./src/lib/alertSituations";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${detail === undefined ? "" : ` -> got: ${JSON.stringify(detail)}`}`);
}

const DAY = 86_400_000;
const now = Date.parse("2026-08-27T12:00:00.000Z");

/** The real shape of the failing account: everything raised, everything dealt with. */
const allResolved: AlertLike[] = [
  { id: "1", repo: "acme/api", type: "repo_made_public", severity: "critical", timestamp: new Date(now - 16 * DAY).toISOString(), resolved: true },
  { id: "2", repo: "acme/web", type: "admin_added", severity: "medium", timestamp: new Date(now - 15 * DAY).toISOString(), resolved: true },
  { id: "3", repo: "acme/ops", type: "admin_added", severity: "medium", timestamp: new Date(now - 15 * DAY + 60_000).toISOString(), resolved: true },
  { id: "4", repo: "acme/api", type: "protection_removed", severity: "high", timestamp: new Date(now - 11 * DAY).toISOString(), resolved: true },
];

(async () => {
  const page = fs.readFileSync("./src/pages/SecurityPage.tsx", "utf8");
  const charts = fs.readFileSync("./src/components/AlertCharts.tsx", "utf8");

  // ── the contradiction cannot come back ──────────────────────────────
  {
    console.log("\nthe page cannot show a summary the list then denies");

    // The bug in one line: the summary ignored `resolved`, the list did not.
    const summarised = toSituations(allResolved);
    check("every alert is summarised, resolved or not",
      summarised.reduce((n, s) => n + s.count, 0) === allResolved.length,
      summarised.reduce((n, s) => n + s.count, 0));

    // So the list's default must not be one that filters any of them away.
    const defaults = page.match(/const NO_FILTERS: Filters = \{[\s\S]{0,220}?\};/)?.[0] ?? "";
    check("  and the list cannot be narrowed by a status at all",
      !/status/.test(defaults),
      "the open/resolved split is what let the two halves disagree");
    check("  with no narrowing on by default",
      /kind: null/.test(defaults) && /repo: null/.test(defaults)
        && /severity: null/.test(defaults) && /week: null/.test(defaults) && /search: ""/.test(defaults),
      defaults);

    // One list, not two views of the same rows. The toggle is what allowed
    // the two halves to drift apart in the first place.
    check("there is no second list behind a toggle",
      !/\[\s*"list",\s*"Every alert"\s*\]/.test(page) && !/view === "list"/.test(page),
      "two lists over one dataset will always find a way to disagree");
    check("  the charts read the unfiltered set",
      /weeklyActivity\(all,/.test(page) && /summarizeKinds\(all,/.test(page),
      "a chart redrawn from the click cannot show where the click sits in the whole");
    check("  and the list reads the filtered one",
      /toSituations\(matching\)/.test(page));
  }

  // ── clicking a group shows the alerts in it ─────────────────────────
  {
    console.log("\na group opens to reveal what is inside it");

    const situations = toSituations(allResolved);
    const grouped = situations.find(s => s.type === "admin_added");
    check("two admin grants a minute apart are one group",
      grouped?.count === 2, grouped?.count);
    check("  and it still names the alerts it covers",
      grouped?.ids.length === 2 && grouped.ids.every(id => allResolved.some(a => a.id === id)),
      grouped?.ids);

    // The row used to be the end of the road: "2 repos" with no way to find
    // out which two. Every alert is already loaded, so opening one costs a
    // click and no request.
    check("the row is a button that expands",
      /aria-expanded=\{open\}/.test(page) && /onToggle/.test(page));
    check("  and resolves back to the loaded alerts by id",
      /s\.ids\.map\(id => byId\.get\(id\)!\)/.test(page),
      "a group that cannot reach its alerts can only ever be a dead end");
    check("  showing the message, who did it, and when",
      /\{a\.message\}/.test(page) && /\{a\.actor\}/.test(page) && /when\(a\.timestamp\)/.test(page));
    check("  and no control that clears it",
      !/onResolve|onReopen|Resolve<\/Button>|Reopen<\/Button>/.test(page),
      "an expandable group with a Resolve button is still a queue");
  }

  // ── every tile and bar is a filter ──────────────────────────────────
  {
    console.log("\nthe dashboard is the filter");

    check("a kind tile narrows the list",
      /toggle\("kind", k\.type\)/.test(page));
    check("a repository chip narrows the list",
      /toggle\("repo", r\.repo\)/.test(page));
    check("a severity in the legend narrows the list",
      /toggle\("severity", s\)/.test(page));
    check("a week in the chart narrows the list",
      /onSelect=\{w => \{ set\("week", w\);/.test(page));

    // Clicking the tile that is already on turns it off, which is the only
    // way out of a filter set by clicking a chart.
    check("  clicking the same one again clears it",
      /set\(k, \(turningOn \? v : null\)/.test(page));

    // The list sits below the charts and is usually off screen, so a tile that
    // only lit itself up read as a tile that did nothing.
    check("  and takes you to what it filtered",
      /if \(turningOn\) reveal\(\);/.test(page) && /scrollIntoView/.test(page));
    check("    but not on the way back out",
      /const turningOn = f\[k\] !== v;/.test(page),
      "being thrown down the page for clearing a filter is its own surprise");
    check("    and never animates for somebody who asked it not to",
      /prefers-reduced-motion: reduce/.test(page));

    // A filter set by clicking a chart is otherwise invisible, and a list
    // that is empty for no visible reason reads as a broken page.
    check("  and every active filter is named and removable",
      /clear all/.test(page) && /const active = \[/.test(page),
      "an empty list with no stated reason reads as a bug");
  }

  // ── a count needs its own history ───────────────────────────────────
  {
    console.log("\na zero is only meaningful next to what came before it");

    const weeks = weeklyActivity(allResolved, 12, now);
    check("twelve weeks are drawn, including the empty ones",
      weeks.length === 12, weeks.length);
    check("  quiet weeks are present rather than skipped",
      weeks.filter(w => w.total === 0).length > 0 && weeks.some(w => w.total > 0),
      "a chart built only from weeks with data draws a busy month like a quiet one");
    check("  every alert lands in exactly one week",
      weeks.reduce((n, w) => n + w.total, 0) === allResolved.length,
      weeks.reduce((n, w) => n + w.total, 0));
    check("  and is counted under its own severity",
      weeks.reduce((n, w) => n + w.bySeverity.critical, 0) === 1
        && weeks.reduce((n, w) => n + w.bySeverity.medium, 0) === 2,
      weeks.map(w => w.bySeverity));

    const kinds = summarizeKinds(allResolved, 12, now);
    const admin = kinds.find(k => k.type === "admin_added")!;
    check("a kind carries its total, not just this week's",
      admin.total === 2 && admin.thisWeek === 0, { total: admin.total, thisWeek: admin.thisWeek });
    check("  and its own weekly shape", admin.spark.length === 12, admin.spark.length);
    check("  and when the last one was, so a zero is not the whole sentence",
      !!admin.last, admin.last);
    check("  which the tile actually says",
      /nothing this week, last \$\{shortDate\(k\.last\)\}/.test(page),
      '"none this week" reads the same whether the last was yesterday or in March');

    // Sorted by what deserves attention, not by volume: sorting by count puts
    // the noisiest kind on top permanently.
    check("kinds are ordered by what wants attention",
      /const urgency = \(k: KindSummary\)/.test(
        fs.readFileSync("./src/lib/alertSituations.ts", "utf8")));
  }

  // ── nothing asks to be cleared ──────────────────────────────────────
  {
    console.log("\nan alert is a record, not a task");

    // The account this was all built from: seventeen alerts, every one dealt
    // with. Under the old model the queue was empty and the list was empty and
    // the dashboard showed seventeen things.
    check("everything still shows, cleared or not",
      recent(allResolved, 30, now).length === allResolved.length,
      "hiding what was cleared is what made the tab contradict itself");

    const lately = recent(allResolved, 7, now);
    check("  and the recent window empties itself as things age",
      lately.length === 0,
      "nothing in this set is newer than eleven days, so the week is genuinely quiet");

    // The reversal is the one fact `resolved` still carries.
    check("a change undone on GitHub is labelled, a button press is not",
      wasReverted({ resolved: true, resolvedBy: "system (auto-resolved)" })
        && !wasReverted({ resolved: true, resolvedBy: "roni" }));

    // Records expire rather than waiting for somebody.
    const service = fs.readFileSync("../backend/src/services/alertService.ts", "utf8");
    check("an alert carries an expiry when it is written",
      /ttl: alertExpiry\(/.test(service),
      "the table had no TTL, so the only way a row ever left was by hand");
    check("  the same retention as the activity log",
      /return activityExpiry\(iso\);/.test(service),
      "two records of one event with different expiry dates is a trap");

    // And the server offers no way to clear one.
    const routes = fs.readFileSync("../backend/src/routes/alerts.ts", "utf8");
    check("there is no route to clear an alert",
      !/\/:id\/resolve|\/:id\/unresolve/.test(routes));
    check("  but a reversal still marks the row",
      /REVERTED_BY/.test(service) && /autoResolveAlerts/.test(service));
  }

  // ── repositories ────────────────────────────────────────────────────
  {
    console.log("\nwhich repositories this keeps happening to");
    const repos = summarizeRepos(allResolved);
    check("a repository under two kinds is one row counting both",
      repos.find(r => r.repo === "acme/api")?.total === 2
        && repos.find(r => r.repo === "acme/api")?.kinds === 2,
      repos.find(r => r.repo === "acme/api"));
    check("  and carries the worst it has seen",
      repos.find(r => r.repo === "acme/api")?.worst === "critical");
  }

  // ── the drawing itself ──────────────────────────────────────────────
  {
    console.log("\nthe chart holds up in both themes and on a phone");

    // Critical and high stay in the danger family the rest of the app uses,
    // with critical the darker. Four unrelated hues would read as four
    // unrelated categories rather than one ramp.
    check("the severity ramp is one ramp",
      /critical: "bg-rose-600/.test(charts) && /high: "bg-rose-400/.test(charts));
    check("  and every step has a dark value",
      (charts.match(/dark:bg-/g) ?? []).length >= 8);

    // A bar drawn at its true proportion disappears when the week has one
    // alert and the peak has forty.
    check("a single alert is still visible against a tall week",
      /Math\.max\(4, \(b\.total \/ peak\) \* 100\)/.test(charts));
    check("  and a week with nothing gets a track rather than nothing at all",
      /b\.total === 0 \?/.test(charts),
      "an empty column with no target is not clickable");

    check("the tooltip never intercepts the pointer",
      /pointer-events-none[\s\S]{0,200}group-hover:opacity-100/.test(charts),
      "moving along the chart would land on the tooltip instead of the next week");
    check("keyboard focus is visible on every clickable bar",
      /focus-visible:ring/.test(charts));
    check("  and each bar says what it is to a screen reader",
      /aria-label=\{`Week of \$\{b\.label\}/.test(charts));
  }

  // ── the badge means what it says ────────────────────────────────────
  {
    console.log("\nundone means GitHub undid it, not that somebody clicked");

    // The real account: fifteen rows cleared by a person through the old
    // queue, three reversed by the worker. The group badge tested
    // `unresolved === 0`, which was true of every group, so all eleven
    // claimed to have been undone.
    const mixed: AlertLike[] = [
      { id: "a", repo: "r1", type: "repo_made_public", severity: "critical", timestamp: new Date(now - 3 * DAY).toISOString(), resolved: true, resolvedBy: "system (auto-resolved)" } as AlertLike,
      { id: "b", repo: "r2", type: "admin_added", severity: "medium", timestamp: new Date(now - 3 * DAY).toISOString(), resolved: true, resolvedBy: "a-person" } as AlertLike,
    ];
    const sits = toSituations(mixed);
    check("a reversal counts",
      sits.find(x => x.type === "repo_made_public")?.reverted === 1);
    check("  a button press does not",
      sits.find(x => x.type === "admin_added")?.reverted === 0,
      "every group said undone because nothing was left unresolved");
    check("  and the badge is drawn from that count",
      /\{s\.reverted > 0 && \(/.test(page) && !/s\.unresolved/.test(page),
      "reading it off `unresolved` is what made the badge lie");
    check("  saying so partially when only part of a group was undone",
      /\$\{s\.reverted\} of \$\{s\.count\} undone/.test(page));
  }

  // ── the list pages ──────────────────────────────────────────────────
  {
    console.log("\nthe record is paged rather than running off the bottom");

    check("a page holds ten groups",
      /const SITUATIONS_PER_PAGE = 10;/.test(page),
      "at twelve, an eleven-group account had one page and the pager hid itself");
    check("  the page is clamped, so a filter cannot strand you past the end",
      /Math\.min\(page, totalPages\)/.test(page));
    check("  and narrowing takes you back to the first page",
      /setPage\(1\);/.test(page));
    check("  the count is against the unfiltered total",
      /totalCount=\{allSituations\.length\}/.test(page),
      '"3 groups" leaves somebody wondering where the other eight went');
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
