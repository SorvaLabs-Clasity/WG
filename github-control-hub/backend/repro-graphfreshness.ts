/**
 * How old the access graph is, and whether the page can tell.
 *
 * Every screen showing who can reach what reads a stored snapshot of the
 * organization. Nothing rebuilt that snapshot on a schedule and nothing recorded
 * when it was last built, so a graph assembled before somebody joined, left or
 * was made an owner was indistinguishable on screen from a current one — and the
 * Refresh button on that page re-reads the derived map from the same stale
 * edges, so pressing it looked like it should have helped and could not.
 *
 * The failures worth guarding are all about lying by omission:
 *
 *   - a failed rebuild erasing the timestamp of the last good one, so the page
 *     says "never rebuilt" about a graph that is merely four hours old.
 *   - a run that died recording success anyway, dating a snapshot that was
 *     never replaced.
 *   - the two timestamps collapsing into one, which loses the state people
 *     actually need: built recently, failing since.
 *
 * No DynamoDB: ACTIVITY_TABLE is unset, so orgConfigService uses its in-memory
 * fallback and this is pure logic.
 */
delete process.env.ACTIVITY_TABLE;

import { getOrgConfig, recordGraphAggregation } from "./src/services/orgConfigService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const HOUR = 3600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

(async () => {
  // ── a failure does not erase the last success ───────────────────────
  {
    await recordGraphAggregation({
      lastSuccessAt: iso(4 * HOUR), edgeCount: 1200, lastError: undefined,
    });
    await recordGraphAggregation({ lastAttemptAt: iso(10 * 60_000) });
    await recordGraphAggregation({ lastError: "rate limited" });

    const { graphAggregation: a } = await getOrgConfig();
    check("a failed attempt keeps the last successful rebuild's timestamp",
      !!a?.lastSuccessAt, a);
    check("  and records the failure alongside it, not instead of it",
      a?.lastError === "rate limited" && !!a?.lastSuccessAt, a);
    check("  so the page can say built-recently-and-failing-since",
      !!a?.lastAttemptAt && Date.parse(a!.lastAttemptAt!) > Date.parse(a!.lastSuccessAt!), a);
    check("  the edge count from the good run survives too",
      a?.edgeCount === 1200, a?.edgeCount);
  }

  // ── a success clears the stale failure ──────────────────────────────
  //
  // Otherwise the warning outlives the problem, and a page that cried wolf once
  // goes on crying it forever.
  {
    await recordGraphAggregation({
      lastSuccessAt: new Date().toISOString(), edgeCount: 1300, lastError: undefined,
    });
    const { graphAggregation: a } = await getOrgConfig();
    check("a later success clears the recorded error", a?.lastError === undefined, a?.lastError);
    check("  and updates the count", a?.edgeCount === 1300, a?.edgeCount);
  }

  // ── the aggregator stamps success only after writing ────────────────
  //
  // Asserted against the source: the success stamp has to sit after the write
  // and inside the try, or a run that threw half way would date a snapshot
  // nobody replaced. The failure is invisible — the page would show a fresh
  // timestamp over stale data, which is worse than showing a stale one.
  {
    const fs = await import("node:fs");
    const src = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");

    const syncDone = src.indexOf("DynamoDB sync complete");
    const successStamp = src.indexOf("lastSuccessAt: new Date().toISOString()");
    const catchLine = src.indexOf("} catch (error) {");

    check("the success timestamp is written after the edges are",
      syncDone > 0 && successStamp > syncDone, { syncDone, successStamp });
    check("  and before the catch, so a thrown run never reaches it",
      catchLine > 0 && successStamp < catchLine, { successStamp, catchLine });
    check("  while the attempt is stamped up front, so a dead run leaves a trace",
      src.indexOf("lastAttemptAt") < syncDone);
    check("  and the catch records the error",
      src.slice(catchLine).includes("lastError"));
  }

  // ── the schedule exists at all ──────────────────────────────────────
  //
  // The comment in the aggregator claimed "this runs every 6 hours" while
  // nothing scheduled it — the only trigger was a button. A stale comment is
  // how that went unnoticed, so the rule is asserted rather than described.
  {
    const fs = await import("node:fs");
    const stack = fs.readFileSync(`${__dirname}/../infra/cdk-stack.ts`, "utf8");
    check("a rule rebuilds the graph on a schedule",
      /GraphAggregationSchedule/.test(stack) && /aggregateHandler/.test(stack));
    check("  measured in hours, not minutes — the walk covers the whole org",
      /GraphAggregationSchedule[\s\S]{0,400}?Schedule\.rate\(cdk\.Duration\.hours\(/.test(stack));
  }

  // ── the sync writes only what changed ───────────────────────────────
  //
  // It deleted every row and rewrote every row on each run. What it describes
  // barely moves between syncs, so nearly every write replaced a row with an
  // identical row — and on-demand DynamoDB bills per write, four times a day,
  // for ever. The scan to find deletable rows was already happening; reading
  // the whole item rather than its key alone is what makes a comparison
  // possible, and reads cost a fraction of writes.
  {
    type E = { pk: string; sk: string; type: string; metadata?: any };
    const fingerprint = (e: { type: string; metadata?: any }) =>
      JSON.stringify({ t: e.type, m: e.metadata ?? null });

    // The same shape the aggregator uses, lifted so it can be exercised rather
    // than only described.
    function plan(storedItems: E[], edges: E[]) {
      const stored = new Map(storedItems.map(i => [`${i.pk}::${i.sk}`, fingerprint(i)]));
      const wanted = new Map<string, E>();
      for (const e of edges) wanted.set(`${e.pk}::${e.sk}`, e);
      const puts = [...wanted].filter(([k, e]) => stored.get(k) !== fingerprint(e)).map(([, e]) => e);
      const deletes = [...stored.keys()].filter(k => !wanted.has(k));
      return { puts, deletes };
    }

    const edge = (pk: string, sk: string, role = "write"): E =>
      ({ pk, sk, type: "collaborates_on", metadata: { role, source: "team" } });

    {
      const same = [edge("USER#a", "REPO#x"), edge("USER#b", "REPO#y")];
      const { puts, deletes } = plan(same, [edge("USER#a", "REPO#x"), edge("USER#b", "REPO#y")]);
      check("a sync where nothing changed writes nothing at all",
        puts.length === 0 && deletes.length === 0, { puts: puts.length, deletes: deletes.length });
    }

    {
      const { puts } = plan([edge("USER#a", "REPO#x", "write")], [edge("USER#a", "REPO#x", "admin")]);
      check("a changed permission is written", puts.length === 1, puts);
    }

    {
      const { puts } = plan([], [edge("USER#a", "REPO#x")]);
      check("a new edge is written", puts.length === 1);
    }

    {
      const { deletes } = plan([edge("USER#gone", "REPO#x")], []);
      check("an edge that no longer exists is deleted, so no orphan survives",
        deletes.join() === "USER#gone::REPO#x", deletes);
    }

    {
      // Duplicates used to be removed per batch of 25, so the same edge produced
      // twice in different batches was written twice — paid for twice, for one
      // row.
      const dup = [edge("USER#a", "REPO#x"), edge("USER#a", "REPO#x")];
      const { puts } = plan([], dup);
      check("an edge produced twice in one run is written once", puts.length === 1, puts.length);
    }

    const src2 = await import("node:fs").then(fs =>
      fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8"));

    check("the aggregator no longer deletes every stored row up front",
      !/Clearing old graph edges/.test(src2),
      "an unconditional delete-all is the cost, and it bought nothing");
    check("  it reads whole items so it can compare them",
      /scanAll<GraphEdge>\(edgesTable\)/.test(src2));
    check("  and a failed read stops the write rather than orphaning rows",
      /Could not read the stored graph, so nothing was written/.test(src2));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
