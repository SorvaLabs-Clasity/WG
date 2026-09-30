/**
 * Dependabot security fixes, held back and released once a month.
 *
 * Driven against a fake GitHub that remembers each repository's switch, so
 * what is checked is where every repository ends up — above all that none is
 * left with its fixes switched off and forgotten.
 *
 * Run:  npx tsx repro-dependabotmonthly.ts   from github-control-hub/backend
 */
import {
  decide, tick, configure, runNow, missedLastOpening, withDefaults, explainForApp,
  type MonthlySchedule, type Deps,
} from "./src/services/dependabotMonthly";
import type { BulkAction, BulkSummary } from "./src/services/dependabotBulk";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

/** A fake GitHub and a fake store. `refuse` makes a repository's switch fail. */
function world(initial: Record<string, boolean>) {
  const fixes: Record<string, boolean> = { ...initial };
  const refuse = new Map<string, string>();
  let stored: MonthlySchedule | undefined;
  const calls: string[] = [];
  const deps: Deps = {
    bulk: async (repos: string[], action: BulkAction): Promise<BulkSummary> => {
      calls.push(`${action}:${repos.join(",")}`);
      const results = repos.map(repo => {
        const why = refuse.get(repo);
        if (why) return { repo, ok: false, error: why };
        fixes[repo] = action === "fixes-on";
        return { repo, ok: true };
      });
      return { results, changed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
        sleptSeconds: 0, leftOff: 0, leftOffRepos: [] };
    },
    load: async () => stored,
    save: async change => (stored = change(stored)),
  };
  return { fixes, refuse, deps, calls, get stored() { return withDefaults(stored); } };
}

// New York is UTC-4 in October and November before the change back.
const at = (iso: string) => new Date(iso);

async function main() {
  console.log("the calendar");
  {
    const s: MonthlySchedule = { ...withDefaults(undefined), enabled: true, repos: ["a"] };
    check("the 1st opens the window", decide(s, at("2026-10-01T12:00:00Z")) === "open");
    check("  any other day does not", decide(s, at("2026-10-02T12:00:00Z")) === "nothing");
    check("  and the 1st is the 1st in New York, not in UTC",
      decide(s, at("2026-11-01T02:00:00Z")) === "nothing"      // still Oct 31, 10pm
        && decide(s, at("2026-11-01T05:00:00Z")) === "open");   // Nov 1, 1am
    check("  once a month, however many hourly passes land on the 1st",
      decide({ ...s, lastOpenedMonth: "2026-10" }, at("2026-10-01T20:00:00Z")) === "nothing");
    check("switched off, it never opens", decide({ ...s, enabled: false }, at("2026-10-01T12:00:00Z")) === "nothing");
    check("  and an empty batch never opens", decide({ ...s, repos: [] }, at("2026-10-01T12:00:00Z")) === "nothing");
    check("an open window closes once it has run its length",
      decide({ ...s, openUntil: "2026-10-02T12:00:00Z" }, at("2026-10-02T12:00:00Z")) === "close"
        && decide({ ...s, openUntil: "2026-10-02T12:00:00Z" }, at("2026-10-02T11:00:00Z")) === "nothing");
  }

  console.log("\na month, end to end");
  {
    const w = world({ a: true, b: true, c: true });
    await configure(w.deps, { enabled: true, repos: ["a", "b"] }, "ron", at("2026-09-30T15:00:00Z"));
    check("joining the batch switches fixes off", w.fixes.a === false && w.fixes.b === false);
    check("  and leaves everything else alone", w.fixes.c === true);

    await tick(w.deps, at("2026-10-01T05:00:00Z"));
    check("on the 1st the fixes come on", w.fixes.a === true && w.fixes.b === true);
    check("  for the window's length", w.stored.openUntil === "2026-10-02T05:00:00.000Z", w.stored.openUntil);

    const mid = await tick(w.deps, at("2026-10-01T20:00:00Z"));
    check("  and stay on through it", mid.did === "nothing" && w.fixes.a === true);

    await tick(w.deps, at("2026-10-02T05:00:00Z"));
    check("then go off again", w.fixes.a === false && w.fixes.b === false && !w.stored.openUntil);

    const later = await tick(w.deps, at("2026-10-15T12:00:00Z"));
    check("  until next month", later.did === "nothing" && w.fixes.a === false);

    await tick(w.deps, at("2026-11-01T06:00:00Z"));
    check("and next month it opens again", w.fixes.a === true && w.stored.lastOpenedMonth === "2026-11");

    check("every run is recorded, newest first",
      w.stored.history.map(h => h.kind).join(",") === "open,close,open,join", w.stored.history.map(h => h.kind));
  }

  console.log("\nnothing is left switched off and forgotten");
  {
    const w = world({ a: true, b: true });
    await configure(w.deps, { enabled: true, repos: ["a", "b"] }, "ron");
    await configure(w.deps, { enabled: true, repos: ["a"] }, "ron");
    check("leaving the batch switches fixes back on", w.fixes.b === true && w.fixes.a === false);

    await configure(w.deps, { enabled: false, repos: ["a"] }, "ron");
    check("turning the schedule off switches every held repository back on", w.fixes.a === true);
    check("  and empties the batch", w.stored.repos.length === 0 && !w.stored.enabled);
  }
  {
    const w = world({ a: true, b: true });
    await configure(w.deps, { enabled: true, repos: ["a", "b"] }, "ron");
    w.refuse.set("b", "Resource not accessible by integration");
    await configure(w.deps, { enabled: false, repos: [] }, "ron");
    check("a repository that could not be switched back on stays in the batch",
      w.stored.repos.join() === "b" && w.stored.enabled, w.stored);
    w.refuse.clear();
    await tick(w.deps, at("2026-10-01T12:00:00Z"));
    check("  so the next window releases it", w.fixes.b === true);
  }
  {
    const w = world({ a: true, b: true });
    w.refuse.set("b", "You do not have admin access to this repository.");
    await configure(w.deps, { enabled: true, repos: ["a", "b"] }, "ron");
    check("a repository whose fixes could not be switched off is not claimed as held back",
      w.stored.repos.join() === "a" && w.fixes.b === true, w.stored.repos);
  }

  console.log("\nwhen the App lacks the permission, it says so");
  {
    const w = world({ a: false });
    await configure(w.deps, { enabled: true, repos: ["a"] }, "ron");
    w.refuse.set("a", "Resource not accessible by integration");
    await tick(w.deps, at("2026-10-01T12:00:00Z"));
    const missed = missedLastOpening(w.stored);
    check("a failed opening is listed as not getting fixes", missed.length === 1 && missed[0].repo === "a", missed);
    check("  in words that say what to grant", /Administration: write/.test(missed[0]?.error ?? ""), missed[0]?.error);
    check("other refusals keep GitHub's own words",
      explainForApp("Archived. GitHub refuses …") === "Archived. GitHub refuses …");
  }

  console.log("\nrun now");
  {
    const w = world({ a: true });
    await configure(w.deps, { enabled: true, repos: ["a"] }, "ron");
    await runNow(w.deps, "ron", at("2026-10-10T12:00:00Z"));
    check("opens the window at once", w.fixes.a === true && !!w.stored.openUntil);
    check("  without using up the month's own window", w.stored.lastOpenedMonth === undefined);
    await tick(w.deps, at("2026-10-11T12:00:00Z"));
    check("  and the hourly job closes it", w.fixes.a === false);
  }
  {
    const w = world({ a: true, b: true });
    await configure(w.deps, { enabled: true, repos: ["a"] }, "ron");
    await runNow(w.deps, "ron", at("2026-10-10T12:00:00Z"));
    await configure(w.deps, { enabled: true, repos: ["a", "b"] }, "ron", at("2026-10-10T13:00:00Z"));
    check("joining while a window is open waits for it to close", w.fixes.b === true);
    await tick(w.deps, at("2026-10-11T12:00:00Z"));
    check("  and is held back when it does", w.fixes.b === false && w.fixes.a === false);
  }
  {
    const w = world({});
    let threw = false;
    try { await runNow(w.deps, "ron"); } catch { threw = true; }
    check("there is nothing to run without a batch", threw);
  }

  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
