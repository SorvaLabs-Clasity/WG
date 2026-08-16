/**
 * Covering a large organization a batch at a time.
 *
 * Run from github-control-hub/backend:  npx tsx repro-querycache.ts
 *
 * Three security checks cost one GitHub request per subject — a commit search
 * per privileged account, or a protection read per repository. That is fine for
 * two accounts and impossible for three hundred, because commit search allows
 * thirty requests a *minute*. The two ways this had been dealt with were both
 * silent:
 *
 *   - the branch-protection checks took `.slice(0, 20)` and said nothing about
 *     the rest, so a sample was presented as a survey
 *   - the dormant-account check ran every subject every pass and dropped the
 *     ones that hit the limit, so the list simply came back shorter
 *
 * Both produce a number smaller than the truth on a security check, which reads
 * as an improvement. Neither produces an error.
 *
 * The replacement keeps a verdict per subject with the time it was taken. Each
 * pass refreshes a budget's worth, oldest first, and the answer is withheld
 * until every subject has a current verdict. The properties that have to hold:
 *
 *   - refreshing converges: every subject is reached, and reached again later
 *   - "checked and clean" is stored, or coverage can never complete
 *   - a verdict past its life stops counting rather than going stale silently
 */
import {
  planRefresh, coverageOf, findingsFrom, describeProgress,
  putVerdict, listVerdicts, __resetQueryCacheForTests, __seedVerdictForTests,
  mayRefresh, markRefreshed, clearThrottle, freshnessOf, isBatched, SUBJECT_COST, budgetFor,
  MIN_REFRESH_GAP_MS, MANUAL_REFRESH_BUDGET_MS,
  VERDICT_TTL_HOURS, REFRESH_BUDGET, type CachedVerdict,
} from "./src/services/queryCacheService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const verdict = (subject: string, hoursAgo: number, finding: any = null): CachedVerdict => ({
  id: `qcache#q#${subject}`, kind: "query-subject", queryId: "q",
  subject, finding, checkedAt: at(hoursAgo), ttl: 0,
});

(async () => {
  // ── the budget is spent on what is least known ───────────────────────
  {
    const subjects = ["a", "b", "c", "d", "e"];
    const cached = [verdict("a", 1), verdict("b", 20), verdict("c", 10)];
    const { refresh } = planRefresh(subjects, cached, 3);

    check("never-checked subjects come first",
      refresh.slice(0, 2).sort().join(",") === "d,e", refresh);
    check("  then the oldest verdict on file", refresh[2] === "b", refresh);
    check("  and the freshest is not re-read", !refresh.includes("a"), refresh);
    check("the budget is a limit, not a target", refresh.length === 3, refresh.length);
  }

  // ── it converges rather than circling ────────────────────────────────
  //
  // The failure this rules out: a plan that keeps picking the same subjects
  // leaves some never reached, and coverage never completes — the check would
  // refuse forever rather than for a few passes.
  {
    const subjects = Array.from({ length: 300 }, (_, i) => `s${String(i).padStart(3, "0")}`);
    const known = new Map<string, CachedVerdict>();
    let passes = 0;

    while (passes < 100) {
      const { refresh } = planRefresh(subjects, [...known.values()], 25);
      if (refresh.length === 0) break;
      for (const s of refresh) known.set(s, verdict(s, 0));
      passes++;
      if (coverageOf(subjects, known).complete) break;
    }

    check("three hundred subjects reach full coverage", coverageOf(subjects, known).complete);
    check("  in twelve passes at a budget of twenty-five", passes === 12, passes);
    check("  which is about an hour at the standard interval", passes * 15 <= 190, passes * 15);
  }
  {
    // And keeps going afterwards, oldest first, rather than stopping.
    const subjects = ["a", "b", "c"];
    const known = new Map([["a", verdict("a", 5)], ["b", verdict("b", 9)], ["c", verdict("c", 1)]]);
    const { refresh } = planRefresh(subjects, [...known.values()], 1);
    check("once complete it still refreshes, oldest first", refresh[0] === "b", refresh);
  }

  // ── a clean subject is a verdict, not a gap ──────────────────────────
  {
    const subjects = ["a", "b"];
    const known = new Map([["a", verdict("a", 1, null)], ["b", verdict("b", 1, { repo: "b" })]]);
    const c = coverageOf(subjects, known);
    check("checked-and-clean counts as covered", c.complete && c.covered === 2, c);
    check("  and contributes no finding", findingsFrom(subjects, known).length === 1,
      findingsFrom(subjects, known));

    // If clean verdicts were not stored, this is what would happen instead.
    const withoutClean = new Map([["b", verdict("b", 1, { repo: "b" })]]);
    check("  where dropping them would leave coverage permanently short",
      !coverageOf(subjects, withoutClean).complete);
  }

  // ── coverage is the gate ─────────────────────────────────────────────
  {
    const subjects = ["a", "b", "c"];
    const partial = new Map([["a", verdict("a", 1, { user: "a" })]]);
    const c = coverageOf(subjects, partial);
    check("partial coverage is not complete", !c.complete && c.covered === 1, c);
    check("  and the findings it does have are not the answer",
      findingsFrom(subjects, partial).length < subjects.length);

    const msg = describeProgress("Dormant Privileged Access", c);
    check("  the message says how far along it is", /checked 1 of 3/.test(msg), msg);
    check("  and why it is not answering", /rather than a list that looks shorter/.test(msg), msg);

    check("no subjects at all is complete, not stuck",
      coverageOf([], new Map()).complete);
  }

  // ── age is enforced on read ──────────────────────────────────────────
  //
  // DynamoDB deletes expired rows on its own schedule, which can be days after
  // the stamp passes. A reader that trusts the row's presence counts last
  // week's verdict as current.
  {
    __resetQueryCacheForTests();
    await putVerdict("q", "fresh", { user: "fresh" });
    const rows = await listVerdicts("q");
    check("a verdict just written is readable", rows.length === 1 && rows[0].subject === "fresh", rows);
    check("  and carries when it was taken", !!rows[0].checkedAt);
    check("  and an expiry beyond its useful life, so the row outlives its meaning",
      rows[0].ttl > Math.floor(Date.now() / 1000) + VERDICT_TTL_HOURS * 3_600, rows[0].ttl);

  }
  {
    // The age rule, run rather than read. A verdict an hour past its life must
    // stop counting even though the row is still sitting in the table — the
    // table's own expiry runs on its own schedule, often days late.
    __resetQueryCacheForTests();
    __seedVerdictForTests(verdict("tooOld", VERDICT_TTL_HOURS + 1, { user: "tooOld" }));
    __seedVerdictForTests(verdict("recent", 1, { user: "recent" }));

    const rows = await listVerdicts("q");
    check("a verdict past its life is not returned",
      rows.length === 1 && rows[0].subject === "recent", rows.map(r => r.subject));

    const { refresh } = planRefresh(["tooOld", "recent"], rows, 1);
    check("  so the subject counts as unchecked and gets re-read first",
      refresh[0] === "tooOld", refresh);
    check("  and coverage is not complete while it stands",
      !coverageOf(["tooOld", "recent"], new Map(rows.map(r => [r.subject, r]))).complete);

    // The boundary itself, an hour inside the window.
    __resetQueryCacheForTests();
    __seedVerdictForTests(verdict("justInside", VERDICT_TTL_HOURS - 1, null));
    check("one just inside the window still counts",
      (await listVerdicts("q")).length === 1);
  }
  {
    __resetQueryCacheForTests();
    await putVerdict("q", "old", null);
    const rows = await listVerdicts("q");
    check("verdicts are scoped to their own check", rows.every(r => r.queryId === "q"), rows);
    check("  and a different check sees none of them",
      (await listVerdicts("other")).length === 0);
  }
  {
    __resetQueryCacheForTests();
    await putVerdict("q", "a", { user: "a" });
    await putVerdict("q", "a", null);
    const rows = await listVerdicts("q");
    check("re-checking a subject replaces its verdict rather than adding one",
      rows.length === 1 && rows[0].finding === null, rows);
  }

  // ── the budget is set below the limit it protects ────────────────────
  {
    check("the refresh budget leaves headroom under search's 30 a minute",
      REFRESH_BUDGET < 30 && REFRESH_BUDGET >= 10, REFRESH_BUDGET);
    check("verdicts live long enough to matter and not so long they mislead",
      VERDICT_TTL_HOURS >= 6 && VERDICT_TTL_HOURS <= 48, VERDICT_TTL_HOURS);
  }

  // ── two callers in the same minute must not both spend budget ────────
  //
  // Refreshing is driven by whoever asks: the scheduled evaluation every
  // fifteen minutes, and every page load. Opening the tab twice would otherwise
  // spend two batches of twenty-five inside one minute, against a limit of
  // thirty — so the second batch fails, which is the failure this design exists
  // to prevent.
  {
    __resetQueryCacheForTests();
    const t0 = 1_000_000;

    check("the first caller may refresh", mayRefresh("q", t0));
    markRefreshed("q", t0);
    check("  a second, moments later, may not", !mayRefresh("q", t0 + 1_000));
    check("  nor at the end of the window", !mayRefresh("q", t0 + MIN_REFRESH_GAP_MS - 1));
    check("  and may again once it has passed", mayRefresh("q", t0 + MIN_REFRESH_GAP_MS));

    check("the gap is well under the fifteen-minute evaluation interval",
      MIN_REFRESH_GAP_MS < 15 * 60_000, MIN_REFRESH_GAP_MS);
    check("  so a scheduled pass is never throttled",
      mayRefresh("q", t0 + 15 * 60_000));

    check("a different check has its own gap", mayRefresh("other", t0 + 1_000));
  }
  {
    // A throttled caller reads, it does not fail. The distinction matters:
    // returning nothing would make a second page load look like a broken check.
    const subjects = ["a", "b", "c"];
    const cached = [verdict("a", 1, { user: "a" }), verdict("b", 1, null), verdict("c", 1, null)];
    const { refresh, known } = planRefresh(subjects, cached, 0);
    check("a zero budget spends nothing", refresh.length === 0, refresh);
    // A negative one too. The list has to be longer than the magnitude to
    // prove anything: `slice(0, -5)` on three items is already empty, so a
    // shorter list would pass whether or not the clamp is there.
    const ten = Array.from({ length: 10 }, (_, i) => `n${i}`);
    check("  and a negative budget spends nothing either",
      planRefresh(ten, [], -5).refresh.length === 0, planRefresh(ten, [], -5).refresh);
    check("  but still answers from what is stored",
      coverageOf(subjects, known).complete && findingsFrom(subjects, known).length === 1);
  }
  {
    // And a throttled caller during the build-up still reports progress rather
    // than pretending coverage is complete.
    const subjects = ["a", "b", "c"];
    const { refresh, known } = planRefresh(subjects, [verdict("a", 1, null)], 0);
    check("a zero budget mid-build stays incomplete",
      refresh.length === 0 && !coverageOf(subjects, known).complete);
  }

  // ── a finding says when it was established ──────────────────────────
  {
    const subjects = ["a", "b"];
    const known = new Map([
      ["a", verdict("a", 3, { repo: "a", bypasses: 2 })],
      ["b", verdict("b", 1, null)],
    ]);
    const [f] = findingsFrom(subjects, known) as any[];
    check("a finding carries the time it was taken", typeof f.checkedAt === "string", f);
    check("  alongside its own fields", f.repo === "a" && f.bypasses === 2, f);
    check("  and a clean subject still contributes none",
      findingsFrom(subjects, known).length === 1);
  }

  // ── freshness, without asking GitHub ────────────────────────────────
  {
    const f = freshnessOf([verdict("a", 5), verdict("b", 1), verdict("c", 20)]);
    check("freshness counts what is stored", f.checked === 3, f);
    // The oldest is what decides how much the whole card can be trusted; the
    // newest would make a mostly-stale set look current.
    check("  and reports the oldest, not the newest",
      f.oldestAt === at(20).slice(0, 16) || f.oldestAt! < f.newestAt!, f);
    const none = freshnessOf([]);
    check("nothing stored is nulls, not a crash",
      none.checked === 0 && none.oldestAt === null && none.newestAt === null, none);
  }

  // ── a person pressing the button is not the case the throttle blocks ─
  {
    __resetQueryCacheForTests();
    const t0 = 2_000_000;
    markRefreshed("q", t0);
    check("the throttle holds against another page load", !mayRefresh("q", t0 + 1_000));
    clearThrottle("q");
    check("  and lets go for somebody who asked", mayRefresh("q", t0 + 1_000));
  }

  // ── the two budgets are paced differently ───────────────────────────
  //
  // Pacing them the same way gets one wrong: search allows thirty a minute, so
  // a second batch of twenty-five inside that minute is over the line. Core
  // allows fifteen thousand an hour, so batches can follow in seconds.
  {
    check("the dormant check is search-backed", SUBJECT_COST["dormant-privileged-users"].budget === "search");
    check("  and cannot batch twice inside a minute",
      SUBJECT_COST["dormant-privileged-users"].gapMs > 60_000,
      SUBJECT_COST["dormant-privileged-users"].gapMs);

    for (const q of ["stale-branch-protections", "protection-bypasses-ranking"]) {
      check(`${q} is core-backed`, SUBJECT_COST[q].budget === "core");
      check(`  so its batches follow in seconds`, SUBJECT_COST[q].gapMs <= 5_000, SUBJECT_COST[q].gapMs);
      // And enough of them fit in one manual refresh to cover a few hundred
      // repositories, or the button would not be worth pressing.
      const batches = Math.floor(MANUAL_REFRESH_BUDGET_MS / SUBJECT_COST[q].gapMs);
      check(`  covering ${batches * REFRESH_BUDGET} subjects in one press`,
        batches * REFRESH_BUDGET >= 250, batches * REFRESH_BUDGET);
    }

    check("only the batched checks are listed", isBatched("dormant-privileged-users"));
    check("  and a graph-only check is not", !isBatched("unowned-repos"));
  }

  // ── the batch is sized to the budget it draws on ────────────────────
  //
  // The old code capped the two protection checks at 20 and 30 repositories.
  // Holding them to the search-shaped batch of 25 would have made an
  // organization with, say, thirty protected repositories wait an extra pass
  // for an answer the capped version returned at once — a regression for
  // exactly the middle-sized case, introduced while fixing the large one.
  {
    check("the search-backed check keeps the small batch",
      budgetFor("dormant-privileged-users") === 25, budgetFor("dormant-privileged-users"));

    for (const q of ["stale-branch-protections", "protection-bypasses-ranking"]) {
      check(`${q} reads more per pass than search allows`, budgetFor(q) > 25, budgetFor(q));
      // Bigger than the cap it replaced, so nothing that used to answer in one
      // load now needs two.
      check(`  and more than the ${q === "stale-branch-protections" ? 20 : 30} it used to cap at`,
        budgetFor(q) >= 30, budgetFor(q));
      // And still cheap: fifty repositories at about three requests each is a
      // hundred and fifty, against fifteen thousand an hour.
      check(`  while costing well under the hourly core allowance`,
        budgetFor(q) * 3 * 12 < 15_000 * 0.2, budgetFor(q) * 3 * 12);
    }

    check("an unlisted check falls back to the default",
      budgetFor("unowned-repos") === REFRESH_BUDGET, budgetFor("unowned-repos"));
  }

  // ── small organizations wait for nothing ────────────────────────────
  //
  // The case that matters most, because it is almost everyone. If the subject
  // count fits in one batch there is no building phase at all: the first pass
  // covers everything and the answer is complete immediately.
  {
    for (const [label, subjects, q] of [
      ["2 privileged accounts", 2, "dormant-privileged-users"],
      ["7 protected repositories", 7, "stale-branch-protections"],
      ["50 protected repositories", 50, "protection-bypasses-ranking"],
    ] as const) {
      const names = Array.from({ length: subjects }, (_, i) => `s${i}`);
      const { refresh, known } = planRefresh(names, [], budgetFor(q));
      check(`${label}: one pass covers them all`, refresh.length === subjects, refresh.length);
      for (const n of refresh) known.set(n, verdict(n, 0));
      check(`  so the answer is complete straight away`, coverageOf(names, known).complete);
    }
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
