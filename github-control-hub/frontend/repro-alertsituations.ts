/**
 * The alerts tab was an inbox, and inboxes generate debt.
 *
 * Every webhook produced a row and every row waited to be resolved. On a busy
 * organization that is a queue nobody keeps up with, and a queue nobody keeps
 * up with is one nobody reads. The alerts were not wrong; the shape was.
 *
 * What is asserted here is the reshaping: a hundred webhooks from one action
 * read as one line, a count is compared against what is normal for that
 * organization, only the severe things still ask to be cleared, and a quiet
 * week looks quiet rather than looking like a list that failed to load.
 *
 * Run:  npx tsx repro-alertsituations.ts   from github-control-hub/frontend
 */
import fs from "node:fs";
import {
  toSituations, trends, recent, wasReverted, isRestingState, countBySeverity,
  worstIn, BASELINE_WEEKS, BURST_GAP_MS,
} from "./src/lib/alertSituations";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-27T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

const alert = (over: Partial<any> = {}): any => ({
  id: Math.random().toString(36).slice(2), repo: "api", type: "team_added",
  severity: "medium", timestamp: at(MIN), resolved: false, ...over,
});

(async () => {
  // ── one action, a hundred webhooks ──────────────────────────────────
  {
    const burst = Array.from({ length: 100 }, (_, i) =>
      alert({ repo: `repo-${i}`, timestamp: at(30 * MIN + i * 1000) }));
    const s = toSituations(burst);
    check("a team added to a hundred repositories is one line",
      s.length === 1 && s[0].count === 100, { lines: s.length, count: s[0]?.count });
    check("  naming every repository it touched",
      s[0].repos.length === 100 && s[0].repos.includes("repo-42"));
    // Not "how many are still open". Nothing is open, and a count of rows
    // where `resolved` was false only ever measured whether somebody had
    // pressed the old button.
    check("  and how many were later undone on GitHub",
      s[0].reverted === 0, s[0].reverted);
  }

  // ── the same kind, days apart, is not one thing ──────────────────────
  {
    const s = toSituations([
      alert({ repo: "a", timestamp: at(2 * DAY) }),
      alert({ repo: "b", timestamp: at(1 * DAY) }),
    ]);
    check("the same kind on different days stays two situations", s.length === 2, s.length);

    const gap = toSituations([
      alert({ repo: "a", timestamp: at(3 * HOUR) }),
      alert({ repo: "b", timestamp: at(3 * HOUR - BURST_GAP_MS - MIN) }),
    ]);
    check("  a gap wider than the burst window splits them", gap.length === 2, gap.length);

    const close = toSituations([
      alert({ repo: "a", timestamp: at(3 * HOUR) }),
      alert({ repo: "b", timestamp: at(3 * HOUR - 30 * MIN) }),
    ]);
    check("  and a gap inside it does not", close.length === 1, close.length);
  }

  // ── different kinds never merge ──────────────────────────────────────
  {
    const s = toSituations([
      alert({ type: "team_added", timestamp: at(MIN) }),
      alert({ type: "admin_added", timestamp: at(MIN) }),
    ]);
    check("two kinds at the same moment are two situations", s.length === 2,
      "a team being added and an admin being added are different things");
  }

  // ── severity is the worst in the group ───────────────────────────────
  {
    const s = toSituations([
      alert({ severity: "low", timestamp: at(MIN) }),
      alert({ severity: "critical", timestamp: at(2 * MIN) }),
      alert({ severity: "medium", timestamp: at(3 * MIN) }),
    ]);
    check("a situation carries the worst severity in it", s[0].severity === "critical",
      "averaging would hide the one that mattered");
  }

  // ── the trend, which is what makes a count mean something ────────────
  {
    const quietHistory = Array.from({ length: 8 }, (_, w) =>
      alert({ type: "repo_made_public", timestamp: at((w + 1) * 7 * DAY) }));
    const spike = Array.from({ length: 4 }, (_, i) =>
      alert({ type: "repo_made_public", timestamp: at(i * DAY) }));
    const t = trends([...quietHistory, ...spike], NOW).find(x => x.type === "repo_made_public")!;
    check("four this week against one a week reads as up",
      t.direction === "up" && t.thisWeek === 4, t);

    const steady = Array.from({ length: 40 }, (_, i) =>
      alert({ type: "admin_added", timestamp: at(i * 1.5 * DAY) }));
    const st = trends(steady, NOW).find(x => x.type === "admin_added")!;
    check("  a normal week reads as steady", st.direction === "steady", st);

    const fresh = trends([alert({ type: "protection_removed", timestamp: at(MIN) })], NOW)[0];
    check("  a kind with no history is new, not a spike",
      fresh.direction === "new",
      "calling it a spike would claim a comparison there was nothing to make");

    const onlyOld = trends([alert({ type: "team_added", timestamp: at(30 * DAY) })], NOW)[0];
    check("  and a kind that stopped is quiet", onlyOld.direction === "quiet", onlyOld);

    // One extra alert on a rare type is not a spike.
    const rare = [alert({ type: "x", timestamp: at(20 * DAY) }), alert({ type: "x", timestamp: at(MIN) })];
    check("  one more than usual is not a spike",
      trends(rare, NOW)[0].direction !== "up",
      "a fifty percent move on a base of one is one alert");
  }

  // ── there is no queue ────────────────────────────────────────────────
  //
  // `needsDecision` used to be here: critical and high, still unresolved, in a
  // list with a Resolve button on each. Nearly every one was a change somebody
  // made on purpose, so clearing it recorded only that a person had pressed a
  // button. What replaced it is a window that empties itself.
  {
    const mixed = [
      alert({ severity: "critical", timestamp: at(1 * DAY) }),
      alert({ severity: "high", timestamp: at(3 * DAY) }),
      alert({ severity: "medium", timestamp: at(20 * DAY) }),
      alert({ severity: "low", timestamp: at(60 * DAY) }),
    ];
    const lately = recent(mixed, 7, NOW);
    check("the recent window holds the last seven days, whatever the severity",
      lately.length === 2, lately.map(a => a.severity));
    check("  newest first, because it is scanned rather than worked through",
      lately[0].timestamp > lately[1].timestamp);
    check("  and it does not care whether anything was ever cleared",
      recent([alert({ resolved: true, timestamp: at(DAY) })], 7, NOW).length === 1,
      "a window that hides what somebody clicked is a queue wearing a hat");

    // The one thing `resolved` still means.
    check("a reversal by the worker reads as undone",
      wasReverted({ resolved: true, resolvedBy: "system (auto-resolved)" }));
    check("  and somebody's old button press does not",
      !wasReverted({ resolved: true, resolvedBy: "roni" }),
      "the two were the same flag, so a reversal looked like an acknowledgement");
  }

  // ── the resting state ────────────────────────────────────────────────
  {
    const calm = Array.from({ length: 40 }, (_, i) =>
      alert({ severity: "medium", resolved: true, timestamp: at(i * 1.5 * DAY) }));
    check("a week with nothing unusual is at rest",
      isRestingState(calm, NOW), "a quiet week must look quiet, not empty");

    // A critical no longer breaks it on its own. Rest is now about rate, not
    // about whether a row is outstanding, because no row ever is.
    const spiking = [
      ...Array.from({ length: 8 }, (_, w) => alert({ type: "p", resolved: true, timestamp: at((w + 1) * 7 * DAY) })),
      ...Array.from({ length: 5 }, (_, i) => alert({ type: "p", severity: "low", resolved: true, timestamp: at(i * DAY) })),
    ];
    check("  and so does a spike, even with nothing open",
      !isRestingState(spiking, NOW),
      "five times the usual rate is worth a look whether or not anybody resolved it");
  }

  // ── the page uses it ─────────────────────────────────────────────────
  {
    const page = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    check("the security page groups alerts into situations",
      /toSituations\(/.test(page));
    // Via summarizeKinds, which folds trends() into the per-kind rows the
    // tiles are drawn from. The trend still reaches the page; it is no longer
    // fetched separately.
    check("  shows the trend beside the count",
      /summarizeKinds\(/.test(page) && /trendWords\(/.test(page));
    check("  and has a resting state", /isRestingState\(/.test(page));

    // The whole point of the change: nothing on this page asks to be cleared.
    check("nothing on the page can be resolved by hand",
      !/onResolve|Resolve<\/Button>|useResolveAlert/.test(page),
      "a button that clears a record is a queue, however it is drawn");
    check("  and the window is what replaced the queue",
      /recent\(all\)/.test(page) && /Last \{RECENT_DAYS\} days/.test(page));
  }

  // ── one critical outweighs a normal rate ────────────────────────────
  //
  // The headline was decided by rate alone: "above its usual rate" or nothing.
  // An organization that makes a repository public most weeks therefore saw a
  // calm "Nothing unusual" over a repository that had just gone public, because
  // the rate was ordinary. The rate was ordinary. The event was not, and it is
  // the event somebody needs to see.
  {
    console.log("\nseverity is not a rate");

    // A kind that happens every week, at its usual rate, one of them critical.
    const usual: AlertLike[] = [];
    for (let w = 1; w <= 9; w++) {
      // Offset by a day so none sits exactly on the seven-day boundary, which
      // `recent` includes and would put two criticals in the window.
      usual.push(alert({ type: "repo_made_public", severity: "critical", timestamp: at(w * 7 * DAY + DAY) }));
    }
    const withOne = [...usual, alert({ type: "repo_made_public", severity: "critical", timestamp: at(DAY) })];

    check("one a week is not a rate anomaly",
      !trends(withOne, NOW).some(t => t.direction === "up" || t.direction === "new"),
      "so rate alone would call this an ordinary week");
    check("  but the week is still not at rest",
      !isRestingState(withOne, NOW),
      "a critical in the window ends the resting state whatever the rate says");

    check("a week with nothing critical and an ordinary rate is at rest",
      isRestingState(usual.map(a => ({ ...a, severity: "low" })), NOW));

    // The headline needs the count, not just the worst.
    const counts = countBySeverity(recent(withOne, 7, NOW));
    check("the counts are per severity, so the headline can lead with one",
      counts.critical === 1 && counts.low === 0, counts);
    check("  and the worst is available on its own",
      worstIn(recent(withOne, 7, NOW)) === "critical");

    const page = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    check("the page leads with critical, not with the rate",
      /bySeverity\.critical > 0 \? "danger"/.test(page)
        && /\$\{bySeverity\.critical\} critical this week/.test(page));
    check("  and does not settle for info on a critical",
      !/worstLately === "critical" \? "info"/.test(page),
      "a critical rendered as a calm blue 'Nothing unusual'");
  }

  // ── the baseline reads in whole events ──────────────────────────────
  {
    console.log("\na tenth of an event is not a thing that happens");

    // One event in the eight-week window is 0.125 a week. Arithmetically right
    // and unreadable: nobody can check "usually 0.1" against what they recall.
    const spiky = [
      alert({ type: "admin_added", timestamp: at(30 * DAY) }),
      ...Array.from({ length: 4 }, (_, i) =>
        alert({ type: "admin_added", timestamp: at((i + 1) * 0.5 * DAY) })),
    ];
    const t = trends(spiky, NOW).find(x => x.type === "admin_added")!;
    check("the spike is detected", t.direction === "up", t);
    check("  and the comparison is a whole count over a stated window",
      t.baselineTotal === 1 && t.baselineWeeks === BASELINE_WEEKS,
      { total: t.baselineTotal, weeks: t.baselineWeeks });

    const page = fs.readFileSync("./src/components/ImportantEvents.tsx", "utf8");
    check("the tile says it that way",
      /\$\{k\.baselineTotal\} in the \$\{k\.baselineWeeks\} weeks before/.test(page));
    check("  and never prints the weekly mean at a reader",
      !/usually \$\{k\.baseline\}/.test(page),
      '"usually 0.1" is a rate wearing the clothes of a count');
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
