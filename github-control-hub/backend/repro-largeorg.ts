/**
 * The whole path, at the size of a real organization.
 *
 * Run from github-control-hub/backend:  npx tsx repro-largeorg.ts
 *
 * Every other suite checks one piece. This one runs the pieces together against
 * the conditions that only appear at scale, because the pieces agreeing
 * individually is not the same as the system working:
 *
 *   - GitHub enforcing thirty commit searches a minute, refusing the rest
 *   - a scheduled evaluation every fifteen minutes and people opening the page
 *     in between, both driving refreshes
 *   - a table big enough to page
 *   - accounts appearing and leaving between passes
 *
 * The question it answers is the one worth asking before pointing this at a
 * production organization: does it reach a complete, correct answer, and does it
 * ever exceed the limit on the way there?
 */
import {
  planRefresh, coverageOf, findingsFrom, mayRefresh, markRefreshed,
  __resetQueryCacheForTests, REFRESH_BUDGET, MIN_REFRESH_GAP_MS,
  type CachedVerdict,
} from "./src/services/queryCacheService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const MINUTE = 60_000;

/** GitHub, refusing anything past thirty commit searches inside a minute. */
function gitHub(limitPerMinute = 30) {
  const stamps: number[] = [];
  let refusals = 0;
  return {
    refusals: () => refusals,
    peakInAnyMinute: () => {
      let peak = 0;
      for (const t of stamps) {
        peak = Math.max(peak, stamps.filter(s => s > t - MINUTE && s <= t).length);
      }
      return peak;
    },
    search(now: number): boolean {
      const recent = stamps.filter(s => s > now - MINUTE).length;
      if (recent >= limitPerMinute) { refusals++; return false; }
      stamps.push(now);
      return true;
    },
  };
}

/**
 * One evaluation, as the check performs it.
 *
 * It refuses while coverage is incomplete, because that is what the shipped
 * check does — `if (!coverage.complete) throw new PartialQueryError(...)` sits
 * ahead of the line that pushes findings. A harness that returned the findings
 * anyway would report a failure that production does not have, and worse, would
 * pass if production ever started returning them.
 */
function pass(
  subjects: string[],
  store: Map<string, CachedVerdict>,
  api: ReturnType<typeof gitHub>,
  now: number,
  dormant: Set<string>,
  queryId = "q",
) {
  const may = mayRefresh(queryId, now);
  const { refresh, known } = planRefresh(
    subjects, [...store.values()], may ? REFRESH_BUDGET : 0);
  if (may) markRefreshed(queryId, now);

  for (const s of refresh) {
    if (!api.search(now)) continue;   // refused; no verdict, so still uncovered
    store.set(s, {
      id: `qcache#${queryId}#${s}`, kind: "query-subject", queryId, subject: s,
      finding: dormant.has(s) ? { user: s } : null,
      checkedAt: new Date(now).toISOString(), ttl: 0,
    });
  }
  const current = new Map([...store].filter(([k]) => subjects.includes(k)));
  const coverage = coverageOf(subjects, current);
  return {
    coverage,
    findings: coverage.complete ? findingsFrom(subjects, current) : null,
  };
}

(async () => {
  // ── three hundred accounts, fifteen-minute passes ────────────────────
  {
    __resetQueryCacheForTests();
    const subjects = Array.from({ length: 300 }, (_, i) => `u${String(i).padStart(3, "0")}`);
    const dormant = new Set(["u007", "u042", "u113", "u250", "u299"]);
    const api = gitHub();
    const store = new Map<string, CachedVerdict>();

    let now = 0, passes = 0, firstComplete = -1;
    let answeredWhileIncomplete = 0;

    for (; passes < 40; passes++) {
      const r = pass(subjects, store, api, now, dormant);
      // The rule: while incomplete the check refuses. Any pass that answered
      // with a short list is the regression this guards.
      if (!r.coverage.complete && r.findings !== null) answeredWhileIncomplete++;
      if (r.coverage.complete && firstComplete === -1) firstComplete = passes;
      now += 15 * MINUTE;
      if (firstComplete !== -1 && passes > firstComplete + 2) break;
    }

    check("three hundred accounts reach complete coverage", firstComplete > -1, firstComplete);
    check("  within twelve passes, three hours of wall clock", firstComplete <= 12, firstComplete);
    check("  never exceeding thirty searches in any minute",
      api.peakInAnyMinute() <= 30, api.peakInAnyMinute());
    check("  with GitHub refusing nothing", api.refusals() === 0, api.refusals());

    const final = coverageOf(subjects, store);
    check("every account ends up covered", final.complete && final.covered === 300, final);
    check("  and exactly the five dormant ones are reported",
      findingsFrom(subjects, store).length === 5, findingsFrom(subjects, store).length);
    check("  having answered nothing while still building",
      answeredWhileIncomplete === 0, answeredWhileIncomplete);
    // And that there *were* incomplete passes to refuse, or the assertion above
    // is satisfied by a run that was complete from the start.
    check("  across eleven passes that had to refuse", firstComplete >= 11, firstComplete);
  }

  // ── people hammering the page between scheduled passes ───────────────
  {
    __resetQueryCacheForTests();
    const subjects = Array.from({ length: 300 }, (_, i) => `u${String(i).padStart(3, "0")}`);
    const api = gitHub();
    const store = new Map<string, CachedVerdict>();

    // Twenty page loads inside one minute, which is what an impatient person
    // and an auto-refreshing tab look like together.
    let now = 0;
    for (let i = 0; i < 20; i++) {
      pass(subjects, store, api, now, new Set());
      now += 3_000;
    }
    check("twenty page loads in a minute do not exceed the limit",
      api.peakInAnyMinute() <= 30, api.peakInAnyMinute());
    check("  and nothing was refused", api.refusals() === 0, api.refusals());
    check("  because only the first spent budget",
      store.size === REFRESH_BUDGET, store.size);
  }

  // ── the roster changes underneath ────────────────────────────────────
  {
    __resetQueryCacheForTests();
    const api = gitHub();
    const store = new Map<string, CachedVerdict>();
    let subjects = Array.from({ length: 30 }, (_, i) => `u${i}`);
    let now = 0;

    for (let i = 0; i < 3; i++) { pass(subjects, store, api, now, new Set(["u1"])); now += 15 * MINUTE; }
    check("a small roster completes", coverageOf(subjects, store).complete);

    // Someone is granted admin. Coverage must drop until they are checked, not
    // silently report complete on a roster that has grown.
    subjects = [...subjects, "newcomer"];
    const before = coverageOf(subjects, store);
    check("a new account makes coverage incomplete again", !before.complete, before);

    const after = pass(subjects, store, api, now, new Set(["u1", "newcomer"]));
    check("  and the next pass covers them", after.coverage.complete, after.coverage);
    check("  reporting them if they are dormant",
      !!after.findings?.some((f: any) => f.user === "newcomer"), after.findings);

    // Someone leaves. Their stored verdict must not keep appearing.
    subjects = subjects.filter(s => s !== "u1");
    const gone = pass(subjects, store, api, now + 15 * MINUTE, new Set(["u1", "newcomer"]));
    check("an account removed from the roster stops being reported",
      !gone.findings?.some((f: any) => f.user === "u1"), gone.findings);
    check("  and coverage is still complete without them", gone.coverage.complete, gone.coverage);
  }

  // ── the limit is genuinely enforced by the fake ──────────────────────
  //
  // Everything above concludes "nothing was refused". That is only meaningful
  // if a refusal is possible, so this proves the fake bites.
  {
    const api = gitHub();
    let refusedAt = -1;
    for (let i = 0; i < 40; i++) if (!api.search(0) && refusedAt === -1) refusedAt = i;
    check("the fake refuses past thirty in a minute", refusedAt === 30, refusedAt);
    check("  and allows again a minute later", api.search(MINUTE + 1));
  }

  // ── an unthrottled version would have blown it ───────────────────────
  //
  // The contrast that makes the numbers above mean something.
  {
    const api = gitHub();
    const subjects = Array.from({ length: 300 }, (_, i) => `u${i}`);
    for (const s of subjects) { void s; api.search(0); }
    check("checking three hundred accounts at once is refused 270 times",
      api.refusals() === 270, api.refusals());
  }

  check("the throttle window is under the evaluation interval",
    MIN_REFRESH_GAP_MS < 15 * MINUTE);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
