/**
 * Detailed GitHub logging: a toggle over collection, never over history.
 *
 * The enterprise audit-log stream is gone. What replaced it is smaller and
 * deliberate: the webhook worker can also record the routine traffic of people
 * working (branches, tags, pushes, pull requests) into the activity feed, but
 * only while an admin has the toggle on, and only the kinds left checked.
 *
 * The properties that must hold, in rough order of how expensive their loss is:
 *
 *   1. Turning it off deletes nothing. Rows written while it was on keep their
 *      full 13-month retention and keep rendering. The setting is prospective.
 *   2. Structure-and-access rows (repo created, protection changed) are not
 *      behind the toggle. They are why the feed exists.
 *   3. A row written under the toggle is marked on the row itself, so the view
 *      filter stays truthful even if the kind list changes later.
 *   4. A settings read that fails skips the detailed row and says so, rather
 *      than writing over an admin's explicit off switch.
 *
 * Run:  npx tsx repro-detailedlogging.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";
import { DETAILED_LOG_KINDS, shouldLogDetailed, __resetDetailedLoggingCache } from "./src/webhooks/detailedLogging";
import { updateDetailedLogging, getDetailedLogging } from "./src/services/orgConfigService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}
const read = (p: string) => fs.readFileSync(path.join(__dirname, p), "utf8");
const code = (s: string) => s.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

(async () => {
  // ── the catalog ─────────────────────────────────────────────────────
  {
    const ids = DETAILED_LOG_KINDS.map(k => k.id);
    check("every kind has a distinct id", new Set(ids).size === ids.length, ids);
    check("  and a label and description for the checkbox list",
      DETAILED_LOG_KINDS.every(k => k.label && k.description));

    // Every kind must come from a webhook event the worker already handles.
    // A kind needing an unticked box would silently never fire.
    const wh = read("src/webhooks/processDelivery.ts");
    const handled = new Set([...wh.matchAll(/event === "([a-z_]+)"/g)].map(m => m[1]));
    check("  every kind is built from an event the worker already receives",
      DETAILED_LOG_KINDS.every(k => handled.has(k.event)),
      DETAILED_LOG_KINDS.filter(k => !handled.has(k.event)).map(k => `${k.id} wants ${k.event}`));
  }

  // ── the gate, against the in-memory store ───────────────────────────
  {
    __resetDetailedLoggingCache();
    check("off by default: nothing detailed is recorded until someone turns it on",
      !(await shouldLogDetailed("push")));

    await updateDetailedLogging({ enabled: true, disabledKinds: [], changedBy: "test" });
    __resetDetailedLoggingCache();
    check("  on: a kind left checked is recorded", await shouldLogDetailed("push"));

    await updateDetailedLogging({ enabled: true, disabledKinds: ["push"], changedBy: "test" });
    __resetDetailedLoggingCache();
    check("  an unchecked kind is skipped while its neighbours still record",
      !(await shouldLogDetailed("push")) && (await shouldLogDetailed("pr-merged")));

    await updateDetailedLogging({ enabled: false, disabledKinds: ["push"], changedBy: "test" });
    __resetDetailedLoggingCache();
    check("  off again: everything detailed stops, whatever the checkboxes say",
      !(await shouldLogDetailed("pr-merged")));

    const s = await getDetailedLogging();
    check("  turning off keeps the checkbox choices for next time",
      s.disabledKinds.includes("push"), s);
    check("  and records who changed it and when",
      s.changedBy === "test" && !!s.changedAt);
  }

  // ── prospective only: nothing in the toggle path deletes rows ───────
  {
    const cfg = read("src/services/orgConfigService.ts");
    const routes = read("src/routes/activity.ts");
    const gateSlice = routes.slice(routes.indexOf("detailed-logging"));
    /**
     * The claim is about the activity table, so the check has to be too.
     *
     * It used to stand on "this file contains no DeleteCommand at all", which
     * held only while the file happened to delete nothing. It now removes the
     * legacy organization-config row once it has copied it forward, in the
     * organization-config table, which has nothing to do with activity. Pinned
     * against the toggle's own function instead, which is what the claim was
     * ever about.
     */
    const toggle = code(cfg).slice(code(cfg).indexOf("export async function updateDetailedLogging"));
    const toggleBody = toggle.slice(0, toggle.indexOf("\nexport "));

    check("turning the toggle deletes no activity rows",
      !/DeleteCommand|BatchWrite|deleteActivity/.test(toggleBody)
        && !/DeleteCommand|deleteActivity/.test(code(gateSlice.slice(0, gateSlice.indexOf("export default")))),
      "the setting governs what is written from now on, never what is stored");

    // And the one delete this file does have is the migration, on its own
    // table, which must never learn to touch the activity one.
    check("  and the only row it ever removes is the migrated config row",
      // Two mentions, and only one of them is a call: the import and the send.
      (code(cfg).match(/new DeleteCommand\(/g) ?? []).length === 1
        && /new DeleteCommand\(\{ TableName: TABLE\(\), Key: \{ org: legacy \} \}\)/.test(code(cfg)),
      "a second delete here would be a different claim needing its own test");
    check("  and the routes say so where the admin reads them",
      /deletes nothing|stays stored|keep rendering/.test(routes));
  }

  // ── the worker: gated rows are flagged, ungated rows are not ────────
  {
    const wh = read("src/webhooks/processDelivery.ts");
    const whCode = code(wh);

    check("every detailed row is written with the flag",
      (whCode.match(/shouldLogDetailed\(/g) ?? []).length >= 3
        && /detailed: true/.test(whCode),
      "unflagged rows would be invisible to the view filter");

    // The always-on rows must not pass through the gate: a repository being
    // created or protection changing is recorded whatever the toggle says.
    const repoLine = whCode.slice(whCode.indexOf('logActivity("repo.created"') - 400, whCode.indexOf('logActivity("repo.created"'));
    check("  repository lifecycle is not behind the toggle",
      !/shouldLogDetailed/.test(repoLine));
    const protLine = whCode.slice(whCode.indexOf('logActivity("github.branch_protection_edited"') - 400, whCode.indexOf('logActivity("github.branch_protection_edited"'));
    check("  branch protection changes are not behind the toggle",
      !/shouldLogDetailed/.test(protLine));

    check("  a failed settings read is logged, not silently treated as off",
      /console\.warn\("\[DetailedLogging\]/.test(read("src/webhooks/detailedLogging.ts")));
    check("  and detailed logging failing cannot fail the delivery",
      /Detailed logging failed/.test(wh),
      "a throw would re-run every other effect of the event");
  }

  // ── the settings routes ─────────────────────────────────────────────
  {
    const routes = read("src/routes/activity.ts");
    const block = routes.slice(routes.indexOf('router.get("/detailed-logging"'));
    check("reading the settings requires an admin", /isAwsAdmin/.test(block.slice(0, 600)));
    const put = block.slice(block.indexOf('router.put'));
    check("  writing them does too", /isAwsAdmin/.test(put.slice(0, 600)));
    check("  a kind id the catalog does not know is refused, not stored",
      /Unknown kinds/.test(put),
      "a typo stored here could never be re-checked; its checkbox does not exist");
    check("  flipping the toggle is itself an activity row",
      /logActivity\("config\.updated"/.test(put));
  }

  // ── the enterprise stream is actually gone ──────────────────────────
  {
    check("no audit ingest, no stream service, no S3 bucket",
      !fs.existsSync(path.join(__dirname, "src/audit"))
        && !fs.existsSync(path.join(__dirname, "src/services/auditStreamService.ts"))
        && !/AuditLogBucket|audit-ingest/.test(code(read("../infra/cdk-stack.ts"))));
    // Removed outright, rows included. The action, the `audit` source and the
    // rows themselves are gone: nothing can write one and nothing renders one,
    // so a lingering union member would be a shape the app can no longer
    // produce and a reader would have to reason about.
    const svc = read("src/services/activityService.ts");
    check("  and no trace of it survives in the row shape",
      !/"audit\.event"/.test(svc) && !/\| "audit"/.test(svc),
      "a source nothing writes is a branch every reader still has to consider");
  }

  // ── the frontend half ───────────────────────────────────────────────
  {
    const page = read("../frontend/src/pages/ActivityPage.tsx");
    const panel = read("../frontend/src/components/DetailedLoggingPanel.tsx");

    check("the panel renders on the Organization stream",
      /category === "github" && <DetailedLoggingPanel \/>/.test(page));
    check("  and only for admins", /isAdmin \|\| !data\) return null/.test(panel.replace(/\n/g, " ")) || /if \(!isAdmin/.test(panel));
    check("  it says outright that turning off keeps history",
      /stays in the feed|Everything already recorded/.test(panel));
    check("  each kind is individually uncheckable",
      /toggleKind/.test(panel) && /checkbox/.test(panel));

    // The filter moved to the server with the rest of them: hiding rows the
    // browser had already loaded only ever hid part of the answer.
    check("the view filter can hide detailed rows",
      /detailed: "hide"/.test(page) && /Detailed rows/.test(page),
      "the filter must reach the query, not the loaded page");
    check("  the choice survives reopening, and a blocked localStorage still renders",
      /activity:show-detailed/.test(page) && /catch \{ return true; \}/.test(page));
    check("  detailed rows carry a visible label",
      /entry\.detailed && \(/.test(page),
      "without it the filter removes rows nobody could identify");
    check("  the audit tab is gone",
      !/AuditStreamSetup/.test(page));
  }

  // ── the toggle records what it changed ──────────────────────────────
  //
  // It used to write "on (6 of 8 kinds)", which is the same sentence whichever
  // kind somebody unchecked. The feed could tell you the shape of a change and
  // never which one it was, which is the only part anybody reads it for.
  {
    const routes = read("src/routes/activity.ts");
    check("the change is compared against what was set before",
      /const before = await getDetailedLogging\(\)/.test(routes),
      "without the previous state there is nothing to diff against");
    check("  and names the kinds that stopped being recorded",
      /stopped recording \$\{stopped\.join/.test(routes));
    check("  and the ones that started",
      /started recording \$\{started\.join/.test(routes));
    check("  by label rather than by id",
      /DETAILED_LOG_KINDS\.find\(k => k\.id === id\)\?\.label/.test(routes),
      '"pr-merged" is not what the checkbox says');
    check("  a save that changed nothing writes no row",
      /if \(parts\.length\) \{/.test(routes),
      "otherwise opening the panel and pressing save records a change");
  }

  // ── the historical rows the filter could not reach ──────────────────
  {
    const fs2 = require("node:fs");
    const script = `${__dirname}/../scripts/backfill-detailed-flag.sh`;
    check("there is a one-time backfill for rows written before the flag existed",
      fs2.existsSync(script),
      "otherwise the hide filter leaves old rows on screen and reads as broken");

    const sh = read("../scripts/backfill-detailed-flag.sh");
    check("  it only touches rows GitHub reported",
      /"S\\":\\"github/.test(sh) || /:s.*github/.test(sh),
      "a branch deleted through this app carries an undo payload and is not detailed traffic");
    check("  it writes only where the flag is absent",
      /attribute_not_exists\(detailed\)/.test(sh),
      "so running it twice is a no-op rather than a rewrite");
    check("  and it does nothing until asked",
      /--apply/.test(sh) && /dry run/.test(sh));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
