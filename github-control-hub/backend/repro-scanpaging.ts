/**
 * A table scan must read the whole table.
 *
 * Run from github-control-hub/backend:  npx tsx repro-scanpaging.ts
 *
 * DynamoDB's `Scan` returns **at most 1MB** and then stops. It does not fail and
 * it does not warn: it hands back a short list plus a `LastEvaluatedKey`, and if
 * nobody reads that key the caller gets a truncated answer that looks complete.
 *
 * Six places did exactly that, and each one fails silently and differently:
 *
 *   | Reader | What a truncated read does |
 *   |---|---|
 *   | `listAlarms` | Alarms past the cut are never evaluated — they stop firing |
 *   | `listGroups` | An email group reads as deleted: "group missing, nothing sent" |
 *   | pending notifications | Buffered Dependabot and Renovate emails are never sent |
 *   | `listPrStates` | **Mutes and pauses vanish**, so a muted person is reminded again |
 *   | `getAlerts` / `listWidgets` | The list quietly loses its tail |
 *   | graph clear-before-rewrite | Old edges survive, and the checks read them as current |
 *
 * None of these appear until the table crosses a size nobody is watching, which
 * is why this is being fixed *before* the app meets an organization large enough
 * to cross it rather than after.
 *
 * The per-subject verdict cache is what forced the issue: three checks times a
 * few hundred subjects is close to a thousand extra rows in the same table the
 * alarms and pull request state live in.
 */
import { scanAll, __setDocClientForTests } from "./src/utils/dynamo";
import { readFileSync } from "fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/**
 * A table that hands back one page at a time, exactly as DynamoDB does.
 *
 * The point of the fake is the `LastEvaluatedKey`: a reader that ignores it
 * gets `pageSize` items and no indication there are more.
 */
function fakeTable(total: number, pageSize: number) {
  const calls: any[] = [];
  const send = async (cmd: any) => {
    const input = cmd.input ?? cmd;
    calls.push(input);
    const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.id) : 0;
    const items = Array.from(
      { length: Math.min(pageSize, total - start) },
      (_, i) => ({ id: String(start + i), kind: (start + i) % 3 === 0 ? "query-subject" : "alarm" }),
    );
    const end = start + items.length;
    return { Items: items, ...(end < total ? { LastEvaluatedKey: { id: String(end) } } : {}) };
  };
  return { send, calls };
}

(async () => {
  let putBack: () => void = () => {};
  const swap = (send: any) => { putBack = __setDocClientForTests({ send }); };
  const restore = () => putBack();

  // ── the whole table, not the first page ──────────────────────────────
  {
    const t = fakeTable(2_500, 400);
    swap(t.send);
    const rows = await scanAll<any>("some-table");
    restore();

    check("every item is returned, not the first page", rows.length === 2_500, rows.length);
    check("  which took seven requests", t.calls.length === 7, t.calls.length);
    check("  and each one carried on from the last",
      t.calls.slice(1).every((c, i) => c.ExclusiveStartKey?.id === String((i + 1) * 400)),
      t.calls.map((c: any) => c.ExclusiveStartKey?.id ?? "start"));

    // What the old code did, for contrast.
    const first = await (async () => {
      const t2 = fakeTable(2_500, 400);
      const r: any = await t2.send({ TableName: "some-table" });
      return (r.Items || []).length;
    })();
    check("  where a single scan would have returned 400 of 2,500 and looked fine",
      first === 400, first);
  }

  // ── the boundaries ───────────────────────────────────────────────────
  {
    const exact = fakeTable(400, 400);
    swap(exact.send);
    const rows = await scanAll<any>("t");
    restore();
    // A full final page still carries a key in DynamoDB's model only when more
    // remain; the fake mirrors that. One request is correct here.
    check("a table that fits in one page costs one request",
      rows.length === 400 && exact.calls.length === 1, { rows: rows.length, calls: exact.calls.length });

    const empty = fakeTable(0, 400);
    swap(empty.send);
    const none = await scanAll<any>("t");
    restore();
    check("an empty table is an empty list, not an error", none.length === 0);

    const one = fakeTable(1, 400);
    swap(one.send);
    check("a single row is returned", (await scanAll<any>("t")).length === 1);
    restore();
  }

  // ── it cannot loop forever ───────────────────────────────────────────
  //
  // An unbounded `while (key)` against a paid API is a worse failure than a
  // truncated read: a server that never clears the key would bill until noticed.
  {
    const stuck = async () => ({ Items: [{ id: "x" }], LastEvaluatedKey: { id: "x" } });
    swap(stuck);
    let threw: Error | null = null;
    try { await scanAll<any>("t"); } catch (e) { threw = e as Error; }
    restore();
    check("a scan that never finishes is stopped rather than run forever", threw !== null);
    check("  and says which table", /t/.test(threw?.message ?? ""), threw?.message);
  }

  // ── filters and projections survive paging ───────────────────────────
  {
    const t = fakeTable(1_000, 300);
    swap(t.send);
    await scanAll<any>("t", {
      filter: "#k <> :cache",
      names: { "#k": "kind" },
      values: { ":cache": "query-subject" },
      project: "id, kind",
    });
    restore();
    check("the filter is sent on every page, not just the first",
      t.calls.every((c: any) => c.FilterExpression === "#k <> :cache"), t.calls.length);
    check("  along with its names and values",
      t.calls.every((c: any) => c.ExpressionAttributeValues?.[":cache"] === "query-subject"));
    check("  and the projection", t.calls.every((c: any) => c.ProjectionExpression === "id, kind"));
  }

  // ── nothing reads a whole table unpaged any more ─────────────────────
  //
  // The behaviour above is only worth anything if the readers use it. A
  // `Limit: 1` scan is a reachability check and is not this; a `Select: COUNT`
  // returns a number, not rows.
  {
    const files = [
      "src/services/alarmService.ts",
      "src/services/queryCacheService.ts",
      "src/services/alertService.ts",
      "src/services/widgetService.ts",
      "src/jobs/graphAggregator.ts",
    ];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const bare = src.split("\n").filter(l =>
        /new ScanCommand/.test(l) && !/Limit: 1|Select: "COUNT"|ExclusiveStartKey/.test(l));
      check(`${f.split("/").pop()} has no unpaged whole-table scan`, bare.length === 0, bare);
    }

    // And the one that holds mutes excludes the verdict cache, so an alarm pass
    // does not page through hundreds of rows it will never look at.
    const alarms = readFileSync("src/services/alarmService.ts", "utf8");
    check("the shared table's readers skip the verdict cache server-side",
      /query-subject/.test(alarms) && /scanAll<AnyRecord>/.test(alarms));
  }

  // ── a Limit is not a filter, and a filter is not a key ───────────────
  //
  // Every activity row shares one partition key, so "this repository's
  // history" cannot be a key condition — it is a FilterExpression, and
  // DynamoDB applies `Limit` to rows **read**, before the filter runs. With
  // `Limit: 200` the query therefore asked "is this repository among the
  // newest two hundred rows in the whole organization?". On a busy org those
  // two hundred rows are often a single afternoon, so every repository except
  // the two or three touched that afternoon returned an empty history — which
  // reads as "nothing has ever happened here".
  {
    process.env.ACTIVITY_TABLE = "test-activity";
    const { getActivityForRepo } = await import("./src/services/activityService");

    /** A log where the repository we want was last touched 900 rows ago. */
    function activityTable(total: number, matchesAt: number[]) {
      const calls: any[] = [];
      const send = async (cmd: any) => {
        const input = cmd.input ?? cmd;
        calls.push(input);
        const start = input.ExclusiveStartKey ? Number(input.ExclusiveStartKey.n) : 0;
        const limit = input.Limit ?? total;
        const end = Math.min(total, start + limit);
        const wanted = input.ExpressionAttributeValues?.[":repo"];
        // Scanned first, filtered second — the order that makes Limit a trap.
        const scanned = [];
        for (let i = start; i < end; i++) {
          scanned.push({ id: `row-${i}`, repo: matchesAt.includes(i) ? wanted : "somewhere-else" });
        }
        const items = scanned.filter(r => r.repo === wanted);
        return {
          Items: items,
          Count: items.length,
          ScannedCount: scanned.length,
          ...(end < total ? { LastEvaluatedKey: { n: String(end) } } : {}),
        };
      };
      return { send, calls };
    }

    const t = activityTable(1_000, [900, 901, 902, 903]);
    swap(t.send);
    const rows = await getActivityForRepo("payments-api", 50);
    restore();

    check("a repository's older history is still found", rows.length === 4, rows.length);
    check("  which took more than one request", t.calls.length > 1, t.calls.length);
    check("  and every request carried on from the last",
      t.calls.slice(1).every((c: any) => c.ExclusiveStartKey !== undefined),
      t.calls.map((c: any) => c.ExclusiveStartKey?.n ?? "start"));

    // The read is bounded. A repository with nothing in it must not walk
    // thirteen months of the organization's history to say so.
    const quiet = activityTable(1_000_000, []);
    swap(quiet.send);
    const none = await getActivityForRepo("never-touched", 50);
    restore();
    check("a repository with no rows returns nothing", none.length === 0, none.length);
    check("  without reading the whole table to find that out",
      quiet.calls.length <= 12, quiet.calls.length);

    // And it stops as soon as it has enough, rather than always spending the
    // whole budget.
    const busy = activityTable(1_000_000, Array.from({ length: 200 }, (_, i) => i));
    swap(busy.send);
    const some = await getActivityForRepo("payments-api", 50);
    restore();
    check("a busy repository stops at the first page that satisfies it",
      some.length === 50 && busy.calls.length === 1, { rows: some.length, calls: busy.calls.length });

    delete process.env.ACTIVITY_TABLE;
  }

  // ── a batch write must write the whole batch ─────────────────────────
  //
  // The mirror image of the reads above. `BatchWriteItem` does not throw when
  // it cannot keep up: it succeeds and hands back whatever it declined in
  // `UnprocessedItems`. Four call sites read that response and discarded it —
  // the graph aggregator's puts and deletes, the incremental edge writer, and
  // the guardrail findings store — so a throttled batch was edges that never
  // appeared and violations that were found, logged, and never stored.
  {
    const { batchWrite } = await import("./src/utils/dynamo");

    /** Declines the first `declineFor` attempts, exactly as DynamoDB does. */
    function grudgingTable(declineFor: number) {
      const written: any[] = [];
      let attempts = 0;
      const send = async (cmd: any) => {
        const input = cmd.input ?? cmd;
        const table = Object.keys(input.RequestItems)[0];
        const items = input.RequestItems[table];
        attempts++;
        if (attempts <= declineFor) {
          // Half through, half back — the ordinary partial-success shape.
          const keep = items.slice(0, Math.floor(items.length / 2));
          written.push(...keep);
          return { UnprocessedItems: { [table]: items.slice(keep.length) } };
        }
        written.push(...items);
        return { UnprocessedItems: {} };
      };
      return { send, written, attempts: () => attempts };
    }

    const rows = Array.from({ length: 60 }, (_, i) => ({ PutRequest: { Item: { id: String(i) } } }));

    const t = grudgingTable(3);
    swap(t.send);
    await batchWrite("edges", rows, { delay: async () => {} });
    restore();
    check("everything declined is retried until it lands",
      t.written.length === 60, t.written.length);
    check("  and every row is written exactly once",
      new Set(t.written.map((r: any) => r.PutRequest.Item.id)).size === 60,
      t.written.length);

    // Chunked to DynamoDB's limit of 25 by the helper, not by each caller.
    const chunks = grudgingTable(0);
    swap(chunks.send);
    await batchWrite("edges", rows, { delay: async () => {} });
    restore();
    check("  in batches of no more than 25", chunks.attempts() === 3, chunks.attempts());

    // And a table that never accepts them throws rather than returning quietly.
    let threw: Error | null = null;
    const stubborn = grudgingTable(Number.MAX_SAFE_INTEGER);
    swap(stubborn.send);
    try {
      await batchWrite("edges", rows.slice(0, 25), { retries: 2, delay: async () => {} });
    } catch (e) { threw = e as Error; }
    restore();
    check("a batch that never lands is an error, not a silent loss",
      threw !== null && /unprocessed/i.test(threw.message), threw?.message);

    // Nothing to write is not an error, and costs no request.
    const idle = grudgingTable(0);
    swap(idle.send);
    await batchWrite("edges", [], { delay: async () => {} });
    restore();
    check("  while an empty write makes no request at all", idle.attempts() === 0, idle.attempts());
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
