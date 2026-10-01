/**
 * Dependabot security fixes, held back and released once a month, in named
 * batches.
 *
 * Driven against a fake GitHub that remembers each repository's switch, so
 * what is checked is where every repository ends up — above all that none is
 * left with its fixes switched off and forgotten.
 *
 * Run:  npx tsx repro-dependabotmonthly.ts   from github-control-hub/backend
 */
import {
  decide, tick, createBatch, updateBatch, deleteBatch, addRepos, removeRepos, runBatch,
  missedLastOpening, withDefaults, explainForApp, nextRelease, BatchError,
  type BatchesConfig, type Deps, type Batch,
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
  let stored: BatchesConfig = withDefaults(undefined);
  const deps: Deps = {
    bulk: async (repos: string[], action: BulkAction): Promise<BulkSummary> => {
      const results = repos.map(repo => {
        const why = refuse.get(repo);
        if (why) return { repo, ok: false, error: why };
        fixes[repo] = action === "fixes-on";
        return { repo, ok: true };
      });
      return { results, changed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length,
        sleptSeconds: 0, leftOff: 0, leftOffRepos: [] };
    },
    fixesOn: async repo => (repo in fixes ? fixes[repo] : null),
    load: async () => stored,
    save: async change => (stored = change(stored)),
  };
  const batch = (name: string) => stored.batches.find(b => b.name === name)!;
  return { fixes, refuse, deps, batch, get config() { return stored; } };
}

const at = (iso: string) => new Date(iso);
const TZ = "America/New_York";
const b0 = (over: Partial<Batch> = {}): Batch => ({
  id: "x", name: "X", repos: ["a"], dayOfMonth: 1, windowHours: 24, history: [],
  createdAt: "2026-01-01T00:00:00Z", createdBy: "ron", ...over,
});

async function main() {
  console.log("the calendar");
  {
    check("the batch's day opens its window", decide(b0(), at("2026-10-01T12:00:00Z"), TZ) === "open");
    check("  any other day does not", decide(b0(), at("2026-10-02T12:00:00Z"), TZ) === "nothing");
    check("  a batch on the 15th opens on the 15th",
      decide(b0({ dayOfMonth: 15 }), at("2026-10-15T12:00:00Z"), TZ) === "open"
        && decide(b0({ dayOfMonth: 15 }), at("2026-10-01T12:00:00Z"), TZ) === "nothing");
    check("  and the day is the day in New York, not in UTC",
      decide(b0(), at("2026-11-01T02:00:00Z"), TZ) === "nothing"      // still Oct 31, 10pm
        && decide(b0(), at("2026-11-01T05:00:00Z"), TZ) === "open");   // Nov 1, 1am
    check("  once a month, however many hourly passes land on the day",
      decide(b0({ lastOpenedMonth: "2026-10" }), at("2026-10-01T20:00:00Z"), TZ) === "nothing");
    check("an empty batch never opens", decide(b0({ repos: [] }), at("2026-10-01T12:00:00Z"), TZ) === "nothing");
    check("an open window closes once it has run its length",
      decide(b0({ openUntil: "2026-10-02T12:00:00Z" }), at("2026-10-02T12:00:00Z"), TZ) === "close"
        && decide(b0({ openUntil: "2026-10-02T12:00:00Z" }), at("2026-10-02T11:00:00Z"), TZ) === "nothing");
    check("the next release is this month's day until it has passed, then next month's",
      nextRelease(b0({ dayOfMonth: 15 }), TZ, at("2026-10-03T12:00:00Z")) === "2026-10-15"
        && nextRelease(b0({ dayOfMonth: 15 }), TZ, at("2026-10-20T12:00:00Z")) === "2026-11-15"
        && nextRelease(b0({ dayOfMonth: 1 }), TZ, at("2026-12-20T12:00:00Z")) === "2027-01-01");
  }

  console.log("\nbatches");
  {
    const w = world({});
    await createBatch(w.deps, { name: "Billing", dayOfMonth: 1 }, "ron");
    await createBatch(w.deps, { name: "Tools", dayOfMonth: 15 }, "ron");
    check("several, each with its own day", w.config.batches.map(b => `${b.name}:${b.dayOfMonth}`).join() === "Billing:1,Tools:15");
    let dup = ""; try { await createBatch(w.deps, { name: "billing", dayOfMonth: 2 }, "ron"); } catch (e: any) { dup = e.message; }
    check("  names are unique", /already a batch/.test(dup), dup);
    let day = ""; try { await createBatch(w.deps, { name: "Late", dayOfMonth: 31 }, "ron"); } catch (e: any) { day = e.message; }
    check("  and the day is the 1st to the 28th, so every month has one", /1st and the 28th/.test(day), day);
    await updateBatch(w.deps, w.batch("Tools").id, { name: "Internal tools", dayOfMonth: 20 }, "ron");
    check("  a batch can be renamed and moved", !!w.batch("Internal tools") && w.batch("Internal tools").dayOfMonth === 20);
  }

  console.log("\nwho can join");
  {
    const w = world({ a: true, b: false, c: true });
    await createBatch(w.deps, { name: "One", dayOfMonth: 1 }, "ron");
    await createBatch(w.deps, { name: "Two", dayOfMonth: 1 }, "ron");
    const r = await addRepos(w.deps, w.batch("One").id, ["a", "b", "zz"], "ron");
    check("a repository whose fix pull requests are on joins, and its fixes go off",
      w.batch("One").repos.join() === "a" && w.fixes.a === false);
    check("  one whose fix pull requests are off is refused, in words",
      /Fix pull requests are off/.test(r.find(x => x.repo === "b")?.error ?? "") && w.fixes.b === false, r);
    check("  one GitHub could not answer about is refused rather than guessed",
      /Could not check/.test(r.find(x => x.repo === "zz")?.error ?? ""), r);
    const r2 = await addRepos(w.deps, w.batch("Two").id, ["a", "c"], "ron");
    check("  one already in another batch is refused, naming the batch",
      /Already in "One"/.test(r2.find(x => x.repo === "a")?.error ?? "") && w.batch("Two").repos.join() === "c", r2);
  }

  console.log("\na month, end to end");
  {
    const w = world({ a: true, b: true, c: true });
    await createBatch(w.deps, { name: "Billing", dayOfMonth: 1 }, "ron", at("2026-09-30T15:00:00Z"));
    await addRepos(w.deps, w.batch("Billing").id, ["a", "b"], "ron", at("2026-09-30T15:00:00Z"));
    check("joining switches fixes off and leaves everything else alone",
      w.fixes.a === false && w.fixes.b === false && w.fixes.c === true);

    await tick(w.deps, at("2026-10-01T05:00:00Z"));
    check("on its day the fixes come on", w.fixes.a === true && w.fixes.b === true);
    check("  for the window's length", w.batch("Billing").openUntil === "2026-10-02T05:00:00.000Z", w.batch("Billing").openUntil);
    await tick(w.deps, at("2026-10-01T20:00:00Z"));
    check("  and stay on through it", w.fixes.a === true);
    await tick(w.deps, at("2026-10-02T05:00:00Z"));
    check("then go off again", w.fixes.a === false && !w.batch("Billing").openUntil);
    await tick(w.deps, at("2026-10-15T12:00:00Z"));
    check("  until next month", w.fixes.a === false);
    await tick(w.deps, at("2026-11-01T06:00:00Z"));
    check("and next month it opens again", w.fixes.a === true && w.batch("Billing").lastOpenedMonth === "2026-11");
    check("every run is recorded, newest first",
      w.batch("Billing").history.map(h => h.kind).join() === "open,close,open,join", w.batch("Billing").history.map(h => h.kind));
  }
  {
    const w = world({ a: true, b: true });
    await createBatch(w.deps, { name: "First", dayOfMonth: 1 }, "ron");
    await createBatch(w.deps, { name: "Fifteenth", dayOfMonth: 15 }, "ron");
    await addRepos(w.deps, w.batch("First").id, ["a"], "ron");
    await addRepos(w.deps, w.batch("Fifteenth").id, ["b"], "ron");
    await tick(w.deps, at("2026-10-15T12:00:00Z"));
    check("two batches release on their own days, independently", w.fixes.a === false && w.fixes.b === true);
  }

  console.log("\nnothing is left switched off and forgotten");
  {
    const w = world({ a: true, b: true });
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a", "b"], "ron");
    await removeRepos(w.deps, w.batch("B").id, ["b"], "ron");
    check("taking a repository out switches its fixes back on", w.fixes.b === true && w.fixes.a === false);
    let blocked = ""; try { await deleteBatch(w.deps, w.batch("B").id); } catch (e: any) { blocked = e.message; }
    check("a batch with repositories in it cannot be deleted", /out of "B" first/.test(blocked), blocked);
    await removeRepos(w.deps, w.batch("B").id, ["a"], "ron");
    await deleteBatch(w.deps, w.batch("B").id);
    check("  an empty one can, with every repository back on", w.config.batches.length === 0 && w.fixes.a === true);
  }
  {
    const w = world({ a: true });
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a"], "ron");
    w.refuse.set("a", "Resource not accessible by integration");
    const r = await removeRepos(w.deps, w.batch("B").id, ["a"], "ron");
    check("a repository that could not be switched back on stays in the batch",
      w.batch("B").repos.join() === "a" && !r[0].ok);
    w.refuse.clear();
    await tick(w.deps, at("2026-10-01T12:00:00Z"));
    check("  so the next window releases it", w.fixes.a === true);
  }
  {
    const w = world({ a: true, b: true });
    w.refuse.set("b", "You do not have admin access to this repository.");
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a", "b"], "ron");
    check("one whose fixes could not be switched off is not claimed as held back",
      w.batch("B").repos.join() === "a" && w.fixes.b === true, w.batch("B").repos);
  }

  console.log("\nwhen the App lacks the permission, it says so");
  {
    const w = world({ a: true });
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a"], "ron");
    w.refuse.set("a", "Resource not accessible by integration");
    await tick(w.deps, at("2026-10-01T12:00:00Z"));
    const missed = missedLastOpening(w.batch("B"));
    check("a failed opening is listed as not getting fixes", missed.length === 1 && missed[0].repo === "a", missed);
    check("  in words that say what to grant", /Administration: write/.test(missed[0]?.error ?? ""), missed[0]?.error);
    check("other refusals keep GitHub's own words", explainForApp("Archived. GitHub refuses …") === "Archived. GitHub refuses …");
  }

  console.log("\nrunning a batch by hand");
  {
    const w = world({ a: true, b: true, c: true });
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a", "b", "c"], "ron");
    await runBatch(w.deps, w.batch("B").id, ["a", "b"], "ron", at("2026-10-10T12:00:00Z"));
    await runBatch(w.deps, w.batch("B").id, ["c"], "ron", at("2026-10-10T12:00:05Z"));
    check("in slices, so the tab can show progress", w.fixes.a && w.fixes.b && w.fixes.c);
    check("  recorded as one run", w.batch("B").history.filter(h => h.kind === "open").length === 1
      && w.batch("B").history[0].results.length === 3, w.batch("B").history);
    check("  the window opens once, from the first slice", w.batch("B").openUntil === "2026-10-11T12:00:00.000Z");
    check("  without using up the month's own release", w.batch("B").lastOpenedMonth === undefined);
    await tick(w.deps, at("2026-10-11T12:00:00Z"));
    check("  and the hourly job closes it", !w.fixes.a && !w.fixes.b && !w.fixes.c);
  }
  {
    const w = world({ a: true, b: true });
    await createBatch(w.deps, { name: "B", dayOfMonth: 1 }, "ron");
    await addRepos(w.deps, w.batch("B").id, ["a"], "ron");
    await runBatch(w.deps, w.batch("B").id, undefined, "ron", at("2026-10-10T12:00:00Z"));
    await addRepos(w.deps, w.batch("B").id, ["b"], "ron", at("2026-10-10T13:00:00Z"));
    check("joining while the window is open waits for it to close", w.fixes.b === true);
    await tick(w.deps, at("2026-10-11T12:00:00Z"));
    check("  and is held back when it does", w.fixes.b === false && w.fixes.a === false);
  }
  {
    const w = world({});
    await createBatch(w.deps, { name: "Empty", dayOfMonth: 1 }, "ron");
    let threw: unknown; try { await runBatch(w.deps, w.batch("Empty").id, undefined, "ron"); } catch (e) { threw = e; }
    check("an empty batch has nothing to run", threw instanceof BatchError);
  }

  console.log("\nthe single batch this replaced");
  {
    const migrated = withDefaults(undefined, { enabled: true, repos: ["a", "b"], windowHours: 24, history: [],
      changedAt: "2026-09-30T00:00:00Z", changedBy: "ron" });
    check("becomes the first named batch, released on the 1st, with its repositories",
      migrated.batches.length === 1 && migrated.batches[0].repos.join() === "a,b" && migrated.batches[0].dayOfMonth === 1);
    check("  and an empty one becomes nothing", withDefaults(undefined, { enabled: false, repos: [] }).batches.length === 0);
  }

  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
