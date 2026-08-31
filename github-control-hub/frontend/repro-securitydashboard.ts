/**
 * The Security tab, after it stopped contradicting itself.
 *
 * The bug that caused the rebuild: the tab had two views behind a toggle. The
 * "Overview" summarised **every** alert, and "Every alert" listed only the
 * **unresolved** ones, because its filter defaulted to "active". On an
 * organization that had dealt with everything, seventeen alerts, all
 * resolved, the overview showed seventeen things and the list showed none.
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
  const page = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
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
        && !wasReverted({ resolved: true, resolvedBy: "a-person" }));

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

  // ── where it lives, and what it is called ───────────────────────────
  //
  // "Security alert" promised a vulnerability and delivered a changelog:
  // almost every row is a legitimate action. The dashboard is the same events
  // as the activity streams, read as a shape rather than as a table, so it
  // sits with them.
  {
    console.log("\nimportant events, in Activity");

    const activity = fs.readFileSync("./src/pages/ActivityPage.tsx", "utf8");
    const router = fs.readFileSync("./src/router.tsx", "utf8");
    const navbar = fs.readFileSync("./src/components/Navbar.tsx", "utf8");

    check("the dashboard is a view inside Activity",
      /<ImportantEvents \/>/.test(activity) && /import ImportantEvents/.test(activity));

    // Named views, not slices and a toggle. Statistics, Events, Important
    // events, Costs and GitHub requests answer different questions and each was
    // getting in the others' way on one screen.
    check("  one of several named views",
      /\["stats", "ph-chart-line-up", "Statistics"\]/.test(activity)
        && /\["important", "ph-shield-warning", "Important events"\]/.test(activity)
        && /\["costs", "ph-currency-dollar", "Costs"\]/.test(activity)
        && /\["github", "[a-z-]+", "GitHub requests"\]/.test(activity));
    // Anchored on the state being separate from the stream, not on how the
    // union is spelled: naming the type moved the words without changing which
    // control picks the view.
    check("  chosen by a segmented control, not by the stream tabs",
      /\blens\b/.test(activity) && /setLensPersistent\(v\)/.test(activity)
        && /const \[category, setCategory\]/.test(activity),
      "the streams are slices of one list; these are different jobs");
    check("  and the choice survives a reload",
      /localStorage\.setItem\("activity:lens"/.test(activity));
    check("  and it replaces the feed rather than filtering it",
      /lens === "important" \? <ImportantEvents \/> : \(/.test(activity));

    // The streams and their filters belong to the feed alone: on Statistics
    // there is no table for them to narrow.
    check("  the stream tabs and filters go with the feed",
      (activity.match(/\{lens === "feed" && \(/g) ?? []).length >= 2);

    // Everything moved, so the Security tab was deleted rather than left as an
    // empty room. A page kept alive with nothing in it is a tab people learn to
    // skip, and then learn to skip when it does have something.
    check("the Security tab is gone",
      !fs.existsSync("./src/pages/SecurityPage.tsx") && !/SecurityPage/.test(router));
    check("  and out of the navigation",
      !/path: "\/security"/.test(navbar));

    // The desktop app restores the route it was last on, so quitting while on
    // that tab would reopen to a blank screen.
    check("  but the route still lands somewhere useful",
      /path: "\/security",[\s\S]{0,80}?<Navigate to="\/activity" replace \/>/.test(router),
      "a removed route is a blank screen for anyone who had it open");

    // The panel decides who is emailed about exactly these events, so it moved
    // with them. A control on a different tab from the thing it controls is a
    // control people do not find.
    const events = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    check("  including the notification settings",
      /<ImportantEventsPanel/.test(events));
  }

  // ── every hook runs on every render ─────────────────────────────────
  //
  // React error #310, live on the work environment: a useMemo sat below the
  // `isLoading` and `isError` guards, next to the prose it fed. The loading
  // render stopped at the guard and ran one hook fewer than the render after
  // it, so the page crashed the moment the query resolved.
  //
  // It went unnoticed on the old Security tab because the query was usually
  // already warm there, so `isLoading` was never true on a first render. Moving
  // the component into Activity gave it a cold mount and it failed immediately.
  {
    console.log("\nhooks, and the guards they must sit above");

    const src = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    const lines = src.split("\n");

    const firstGuard = lines.findIndex(l => /^\s*if \((isLoading|isError)\)/.test(l));
    check("the component has an early return to guard against", firstGuard > 0, firstGuard);

    const late = lines
      .map((l, i) => [i, l] as const)
      .filter(([i, l]) => i > firstGuard && /\buse(Memo|State|Ref|Effect|Callback)\(/.test(l))
      // Nested components declared later in the file have their own render, so
      // their hooks are not this component's.
      .filter(([i]) => !lines.slice(0, i).some((l, j) => j > firstGuard && /^(export )?function [A-Z]/.test(l)));

    check("  and no hook below it",
      late.length === 0,
      late.map(([i, l]) => `${i + 1}: ${l.trim()}`));
  }

  // ── the feed names the event, not the drawer ────────────────────────
  //
  // Every one of these rows read "Security Alert", which is the category
  // rather than the thing: a repository going public and somebody being
  // granted admin are not the same event and should not render as one.
  {
    console.log("\nnaming the event in the feed");

    const page = fs.readFileSync("./src/pages/ActivityPage.tsx", "utf8");
    const lib = fs.readFileSync("./src/lib/importantEvents.ts", "utf8");
    const events = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    const { IMPORTANT_KINDS, importantLabel } = await import("./src/lib/importantEvents");

    check("the chip shows which event it was",
      /entry\.action === "security\.alert"[\s\S]{0,80}?importantLabel\(entry\.importantKind\)/.test(page));
    check("  badged as important, the way detailed rows are badged",
      /important\n/.test(page) && /entry\.action === "security\.alert" && \(/.test(page),
      "the badge is what makes the show/hide filter legible");

    // A row from before the kind was stored genuinely does not say which event
    // it was, and reading it out of the prose would be a guess.
    check("a row with no kind falls back rather than guessing",
      importantLabel(undefined) === "Security event"
        && importantLabel("repo_made_public") === "Repository made public");

    // Two lists naming the same events have to agree, or the feed and the
    // dashboard call the same row different things.
    const onDash = [...events.matchAll(/^\s{2}(\w+): "([^"]+)",$/gm)]
      .filter(m => /_/.test(m[1]))
      .map(m => [m[1], m[2]] as const);
    check("  and the feed's names match the dashboard's",
      onDash.length > 0 && onDash.every(([id, label]) =>
        !IMPORTANT_KINDS.some(k => k.id === id) || IMPORTANT_KINDS.find(k => k.id === id)!.label === label),
      onDash.filter(([id, label]) =>
        IMPORTANT_KINDS.some(k => k.id === id && k.label !== label)));
    check("  covering every kind the dashboard knows",
      onDash.every(([id]) => IMPORTANT_KINDS.some(k => k.id === id)),
      onDash.filter(([id]) => !IMPORTANT_KINDS.some(k => k.id === id)).map(x => x[0]));

    check("they can be hidden, and narrowed to some of them",
      /important: "hide" as const/.test(page) && /importantKinds: importantKinds\.join/.test(page));
    check("  with none selected meaning all, not none",
      /showImportant && importantKinds\.length \? \{ importantKinds/.test(page),
      "a whitelist would show an empty table until somebody ticked something");
    check("  and the choice survives a reload",
      /activity:show-important/.test(page) && /activity:important-kinds/.test(page));

    // The filters shipped doing nothing at all. `serverQuery` is memoised, and
    // neither new value was in its dependency array, so the object never
    // rebuilt, the query key never changed and React Query never refetched.
    // From the outside it looked exactly like a broken backend.
    const deps = page.match(/\}\), \[debouncedSearch[\s\S]{0,160}?\]\);/)?.[0] ?? "";
    check("  and every value the query reads is a dependency of it",
      /showImportant/.test(deps) && /importantKinds/.test(deps) && /showDetailed/.test(deps),
      deps.replace(/\s+/g, " "));

    // Read straight out of the built object, so a filter that is set but never
    // sent cannot pass by being mentioned somewhere else in the file.
    const built = page.match(/const serverQuery = useMemo\(\(\) => \(\{[\s\S]*?\}\), \[/)?.[0] ?? "";
    check("  and both are actually put on the request",
      /important: "hide"/.test(built) && /importantKinds: importantKinds\.join/.test(built));
  }

  // ── how long is dormant ─────────────────────────────────────────────
  {
    console.log("\ndormant is a length of time somebody chooses");

    const opts = fs.readFileSync("./src/utils/queryOptions.ts", "utf8");
    const graph = fs.readFileSync("../backend/src/services/graphService.ts", "utf8");

    check("the check takes a number of months",
      /dormant-privileged-users[^\n]*requiresParam: true[^\n]*paramDefault: "6"/.test(opts));
    check("  and the backend reads it rather than hardcoding six",
      /const dormMonths = Math\.max\(1, parseInt\(String\(param \?\? "6"\), 10\) \|\| 6\)/.test(graph));
    check("  including in what the finding says",
      /in the last \$\{dormMonths\} months/.test(graph),
      "a finding that says six months while measuring twelve is worse than no finding");

    // A verdict is an answer about one window. Cached under the bare login, a
    // widget asking for twelve months would be served the six-month answer.
    check("  and a cached verdict is tied to the window it was computed for",
      /const dormKey = \(u: string\) => `\$\{u\}@\$\{dormMonths\}m`/.test(graph)
        && /putVerdict\("dormant-privileged-users", key, finding\)/.test(graph));
    check("    on the subject, not the check id",
      /budgetFor\("dormant-privileged-users"\)/.test(graph),
      "budgetFor and isBatched look the id up in a table a composite one falls off");
  }

  // ── the feature is called one thing everywhere ──────────────────────
  //
  // "Security alert" survived in the copy long after the tab was renamed:
  // the panel heading, the words in the emails, the activity rows written when
  // settings changed. A feature with two names is two features to anybody
  // reading about it.
  {
    console.log("\ncalled the same thing everywhere");

    const read = (p: string) => fs.readFileSync(p, "utf8");
    const visible = [
      ["../backend/src/alarms/feedNotify.ts", /singular: "important event", plural: "important events"/],
      ["../backend/src/services/alarmService.ts", /Important event emails/],
      ["../backend/src/services/alertService.ts", /Important event \[\$\{severity/],
      ["./src/components/ImportantEventsPanel.tsx", /Email me about important events/],
    ] as [string, RegExp][];
    for (const [f, re] of visible) {
      check(`  ${f.split("/").pop()} says important event`, re.test(read(f)), f);
    }

    // The stored side is deliberately untouched. Renaming a row id orphans the
    // settings somebody saved; renaming the action orphans rows this session
    // has already backfilled *to* it; renaming the feed key orphans the
    // notification buffer. The words people read and the strings the data is
    // keyed on are not the same thing.
    const alarm = read("../backend/src/services/alarmService.ts");
    const alerts = read("../backend/src/services/alertService.ts");
    check("  while the stored keys are left alone",
      /SECURITY_SETTINGS_ID = "security-settings"/.test(alarm)
        && /kind: "security"/.test(alarm)
        && /"security\.alert",/.test(alerts),
      "renaming a stored key orphans the data written under the old one");

    // The details prefix changed, so a re-run of the backfill has to match
    // rows from both sides of the rename.
    const script = read("../scripts/backfill-security-alert-action.sh");
    check("  and the backfill accepts either prefix",
      /Security Alert \[/.test(script) && /Important event \[/.test(script),
      "rows written before the rename would stop matching otherwise");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
