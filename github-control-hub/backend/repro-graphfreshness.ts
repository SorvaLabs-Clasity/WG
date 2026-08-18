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

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
