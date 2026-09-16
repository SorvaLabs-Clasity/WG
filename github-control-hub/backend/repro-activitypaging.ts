/**
 * The activity feed's page is refilled after redaction, not before.
 *
 * Stage 3 shipped redaction that dropped rows from a page the store had
 * already sliced to `limit`, then reported the store's `cursor` and
 * `exhausted` alongside the shortened result. A viewer permitted to see few
 * rows got a nearly empty page marked exhausted, which reads as "nothing else
 * happened". These are the properties that stop that coming back.
 */
import { fillPage, type SourcePage } from "./src/services/activityPaging";
import type { ActivityEntry } from "./src/services/activityService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const row = (id: number, actor: string): ActivityEntry =>
  ({ id: String(id), actor, action: "thing", timestamp: new Date(id * 1000).toISOString() } as ActivityEntry);

/** A store holding `total` rows, handing out `size` at a time. */
function store(total: number, size: number, actorFor: (i: number) => string) {
  let reads = 0;
  const fetch = async (cursor: string | undefined): Promise<SourcePage> => {
    reads++;
    const from = Number(cursor ?? 0);
    const entries = Array.from({ length: Math.min(size, total - from) }, (_, k) => row(from + k, actorFor(from + k)));
    const next = from + entries.length;
    return { entries, cursor: String(next), exhausted: next >= total, examined: entries.length };
  };
  return { fetch, reads: () => reads };
}

const keepAll = async (e: ActivityEntry[]) => e;
const keepMine = async (e: ActivityEntry[]) => e.filter(r => r.actor === "me");

async function main() {
  console.log("an unrestricted viewer pays nothing for the refill");
  {
    const s = store(500, 50, () => "me");
    const page = await fillPage(s.fetch, keepAll, 50, undefined);
    check("one fetch, because the first page came back full", s.reads() === 1, s.reads());
    check("  and the page is the size asked for", page.entries.length === 50, page.entries.length);
    check("  and it is not claimed exhausted", page.exhausted === false);
  }

  console.log("\na restricted viewer gets a full page, not a short one");
  {
    // One row in three survives redaction: a 50-row fetch yields about 17.
    const s = store(5000, 50, i => i % 3 === 0 ? "me" : "someone-else");
    const page = await fillPage(s.fetch, keepMine, 50, undefined);
    check("it kept fetching rather than returning seventeen rows",
      page.entries.length >= 50, page.entries.length);
    check("  and every row returned is one they may see",
      page.entries.every(r => r.actor === "me"));
    check("  and it took more than one fetch to get there", page.fetches > 1, page.fetches);

    /**
     * The bound wins over fullness, and that is the intended order. A viewer
     * who may see one row in ten cannot be given fifty without reading five
     * hundred, so they get a short page that is honestly labelled rather than
     * a long wait. What they must never get is a short page labelled final.
     */
    const sparse = store(100_000, 50, i => i % 10 === 0 ? "me" : "someone-else");
    const short = await fillPage(sparse.fetch, keepMine, 50, undefined, 6);
    check("a viewer who may see very little gets a short page, bounded not exhausted",
      short.entries.length < 50 && short.exhausted === false && short.boundHit === true,
      { rows: short.entries.length, exhausted: short.exhausted, boundHit: short.boundHit });
    check("  and can still page onward from it",
      typeof short.cursor === "string" && short.cursor !== "0");
  }

  console.log("\nexhausted means exhausted, for both viewers");
  {
    const s = store(30, 50, () => "me");
    const unrestricted = await fillPage(s.fetch, keepAll, 50, undefined);
    check("a store with 30 rows answers exhausted", unrestricted.exhausted === true);

    const s2 = store(30, 50, i => i % 10 === 0 ? "me" : "nobody");
    const restricted = await fillPage(s2.fetch, keepMine, 50, undefined);
    check("  and so does the same store seen through a filter",
      restricted.exhausted === true);
    check("  with only the rows that survived", restricted.entries.length === 3, restricted.entries.length);
    check("  which is the honest answer: the source really did run out, so a short "
      + "page here is not the bug — reporting a full source as exhausted was",
      restricted.exhausted === true && restricted.entries.length < 50);
  }

  console.log("\nthe cursor describes the page actually returned");
  {
    const s = store(5000, 50, i => i % 10 === 0 ? "me" : "someone-else");
    const first = await fillPage(s.fetch, keepMine, 50, undefined);
    const second = await fillPage(s.fetch, keepMine, 50, first.cursor);

    const ids = new Set(first.entries.map(e => e.id));
    const overlap = second.entries.filter(e => ids.has(e.id));
    check("the second page repeats nothing from the first", overlap.length === 0, overlap.map(e => e.id));
    check("  and it is not empty, so the cursor advanced rather than ran off the end",
      second.entries.length > 0, second.entries.length);
  }

  console.log("\nthe refill is bounded, so one request cannot scan the table");
  {
    // Nothing survives: without a bound this would read all 100,000 rows.
    const s = store(100_000, 50, () => "someone-else");
    const page = await fillPage(s.fetch, keepMine, 50, undefined, 6);
    check("it stopped at the bound", s.reads() === 6, s.reads());
    check("  and did not claim the source was exhausted", page.exhausted === false);
    check("  and said so, so the caller can tell a bounded page from a final one",
      page.boundHit === true);
    check("  and still returns a cursor, so 'load more' continues from the right place",
      typeof page.cursor === "string" && Number(page.cursor) === 300, page.cursor);
  }

  console.log("\nthe count of hidden rows is never computed, let alone returned");
  {
    /**
     * The rejected alternative was to report how many rows redaction dropped.
     * That number is exactly what `activity.read.app.rows` withholds — "26 rows
     * hidden" tells a viewer twenty-six things happened that they may not see.
     * `FilledPage` must not carry it.
     */
    const s = store(500, 50, i => i % 10 === 0 ? "me" : "someone-else");
    const page = await fillPage(s.fetch, keepMine, 50, undefined);
    const leaks = Object.keys(page).filter(k => /hidden|dropped|redacted|filtered|removed/i.test(k));
    check("no field on the returned page counts what was withheld", leaks.length === 0, leaks);
    check("  and `examined` counts the source's own reads, which is a cost, not a census",
      page.examined >= page.entries.length);
  }
}

main().then(() => {
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
});
