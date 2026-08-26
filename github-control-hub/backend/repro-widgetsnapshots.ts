/**
 * The dashboard opens with stored answers, not with a page of live checks.
 *
 * Every widget used to compute inside the request that drew it: a full scan of
 * the graph table, live GitHub calls for the dependency cards, and — for the
 * three subject-by-subject checks — up to twenty-five commit searches against a
 * budget of thirty a minute. All of it on a cold process, immediately after
 * launching the app, with somebody watching.
 *
 * The scheduled pass already computed exactly these rows for any widget an
 * alarm watched. It now does it for every widget and stores the result.
 *
 * What is asserted here is the part that would quietly rot: that a trimmed
 * snapshot still reports the true count, that a stored error is not served as
 * an answer, and that the live sources are switched *off* when a snapshot is
 * used — fetching them anyway would leave the cost where it was and only hide
 * it from the loading state.
 *
 * Run:  npx tsx repro-widgetsnapshots.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import {
  saveWidgetSnapshot, readWidgetSnapshots, deleteWidgetSnapshot, widgetSnapshotId,
} from "./src/services/alarmService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const read = (p: string) => fs.readFileSync(`${__dirname}/${p}`, "utf8");

(async () => {
  // ── storing and reading back ────────────────────────────────────────
  {
    await saveWidgetSnapshot("w1", { rows: [{ repo: "api" }, { repo: "web" }] });
    const all = await readWidgetSnapshots();
    const one = all.find(s => s.widgetId === "w1");

    check("a snapshot is stored and read back", !!one);
    check("  with its rows", one?.rows.length === 2, one?.rows);
    check("  its true count", one?.total === 2, one?.total);
    check("  and when it was computed", !!one && !Number.isNaN(Date.parse(one.computedAt)));
    check("  not trimmed, because it fitted", one?.trimmed === false);
  }

  // ── a check that could not run is not an answer ─────────────────────
  {
    await saveWidgetSnapshot("w2", { rows: null, error: "GitHub rate limit exceeded" });
    const one = (await readWidgetSnapshots()).find(s => s.widgetId === "w2");
    check("a failed check stores its reason", one?.error === "GitHub rate limit exceeded", one?.error);
    check("  with no rows, rather than an empty result that reads as clean",
      one?.rows.length === 0 && one?.total === 0, one);
  }

  // ── too large to store whole ────────────────────────────────────────
  //
  // DynamoDB refuses an item over 400KB. Refusing the snapshot would put the
  // card back to computing live, which is the case this exists to remove — so
  // it is trimmed, and the count stays true so the card is still right.
  {
    const many = Array.from({ length: 20_000 }, (_, i) => ({
      repo: `repository-with-a-realistic-name-${i}`,
      reason: "No owning team is set for this repository",
    }));
    await saveWidgetSnapshot("w3", { rows: many });
    const one = (await readWidgetSnapshots()).find(s => s.widgetId === "w3");

    check("an oversized result is stored rather than refused", !!one && one.rows.length > 0);
    check("  trimmed to fit", one?.trimmed === true && (one?.rows.length ?? 0) < many.length,
      { kept: one?.rows.length, of: many.length });
    check("  while still reporting the true count",
      one?.total === many.length, one?.total);
    check("  and small enough that DynamoDB would take it",
      Buffer.byteLength(JSON.stringify(one?.rows ?? [])) <= 300_000,
      Buffer.byteLength(JSON.stringify(one?.rows ?? [])));
  }

  // ── a deleted widget leaves nothing behind ──────────────────────────
  {
    await deleteWidgetSnapshot("w1");
    check("deleting a widget's snapshot removes it",
      !(await readWidgetSnapshots()).some(s => s.widgetId === "w1"));
    check("  and the others are untouched",
      (await readWidgetSnapshots()).some(s => s.widgetId === "w2"));
    check("  the id is namespaced, so it cannot collide with an alarm",
      widgetSnapshotId("w1").startsWith("widget-snapshot#"), widgetSnapshotId("w1"));
  }

  // ── the pass writes one for every widget, not only alarmed ones ─────
  {
    const handler = read("src/alarms/handler.ts");
    check("the scheduled pass stores a snapshot for every widget",
      /listWidgets\(\)/.test(handler) && /saveWidgetSnapshot\(widget\.id/.test(handler));
    check("  reusing the sources the alarm evaluation already built",
      /computeWidgetRows\(widget as any, sources\)/.test(handler),
      "a second set would re-run the searches the memoised one already made");
    check("  one widget failing does not cost the others their snapshot",
      /catch \(err: any\) \{[\s\S]{0,400}saveWidgetSnapshot\(widget\.id, \{\s*\n\s*rows: null/.test(handler));
    check("  and a failure of the whole pass does not fail the alarms",
      /snapshot pass failed/.test(handler));
  }

  // ── the dashboard actually stops fetching ───────────────────────────
  {
    const page = read("../frontend/src/pages/AnalyticsPage.tsx");
    check("the live sources are switched off when a snapshot is used",
      /useDependencies\(!fromSnapshot\)/.test(page)
      && /const isQuery = !fromSnapshot/.test(page)
      && /const isBypass = !fromSnapshot/.test(page),
      "fetching and ignoring would leave the cost exactly where it was");
    check("  a stored error falls through to a live read",
      /!!snapshot && !snapshot\.error/.test(page));
    check("  and so does a trimmed one when every row is needed",
      /needAllRows && snapshot\.trimmed/.test(page),
      "a card can be served from a short list; a table listing them cannot");
    check("  the detail view asks for every row",
      /useWidgetData\(config, \{ needAllRows: true, live \}\)/.test(page));
    check("    and honours the refresh window too",
      /<CheckDetail\s+config=\{focused\}\s+live=\{live\}/.test(page),
      "otherwise Refresh goes live on the Overview and the detail keeps the old snapshot");
    check("refresh forces a live pass rather than refetching the same answer",
      /setLiveUntil\(Date\.now\(\) \+ LIVE_WINDOW_MS\)/.test(page)
      && /useWidgetData\(config, \{ live \}\)/.test(page));
    check("  and the page says how old the numbers are",
      /Checked \{ago\(oldestComputedAt\)\}/.test(page),
      "a stale figure shown as current is the thing this is meant to avoid");
  }

  await deleteWidgetSnapshot("w2");
  await deleteWidgetSnapshot("w3");
  // ── the denominator travels with the answer ─────────────────────────
  //
  // The card divides its row count by the number of repositories to pick its
  // colour and its share. That number used to come from a separate request that
  // landed seconds after the snapshot, so every repository-scoped card opened
  // with no share, drew itself amber, said "found" instead of "of N
  // repositories", and repainted once the listing arrived. It was already known
  // when the rows were computed.
  {
    const svc = read("src/services/alarmService.ts");
    const handler = read("src/alarms/handler.ts");
    const page = read("../frontend/src/pages/AnalyticsPage.tsx");

    check("a snapshot can carry the repository count it was measured against",
      /repoTotal\?: number/.test(svc));
    check("  it is written with the rows",
      /typeof repoTotal === "number" \? \{ repoTotal \}/.test(svc));
    check("  and read back out again",
      /repoTotal: row\.repoTotal/.test(svc),
      "stored but not returned is the same as not stored");
    check("  counted once per pass, not once per widget",
      handler.indexOf("const repoTotal") < handler.indexOf("for (const widget of all)"),
      "a scan per widget would undo the point of computing them together");
    check("  from the edges already in memory",
      /scanGraphEdges\(\)[\s\S]{0,120}repo_meta/.test(handler));
    check("  and a count that cannot be read is left unknown, not zero",
      /\.catch\(\(\) => null\)/.test(handler),
      "zero repositories would make every share 100%");

    check("the card prefers the stored denominator over the live listing",
      /typeof snapshot\?\.repoTotal === "number" \? snapshot\.repoTotal/.test(page));
    check("  falling back to the listing when the snapshot predates this",
      /: repos \? repos\.length : null/.test(page),
      "snapshots written before this change carry no count");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
