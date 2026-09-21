/**
 * What the alarm pass spends, and why it should be most of the time nothing.
 *
 * The function was running close to its five-minute ceiling on nearly every
 * invocation — about $21 a month of compute on one install, and a standing
 * draw on the GitHub App's rate limit. A time budget stopped the overruns, but
 * a budget alone saves little when every pass has more work than time: it
 * stops at 270 seconds instead of 300 and does the same again five minutes
 * later. The question these answer is why there was always that much work.
 *
 * Three things ran in full on every pass with nothing checking whether they
 * needed to, and one kept itself alive forever.
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const src = fs.readFileSync("./src/alarms/handler.ts", "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const views = fs.readFileSync("./src/services/viewSnapshot.ts", "utf8");
const me = fs.readFileSync("./src/routes/me.ts", "utf8");

console.log("the dashboard snapshots refresh only when stale");
{
  /**
   * Every widget was recomputed every five minutes, 288 times a day, with live
   * GitHub reads including commit search — thirty requests a minute, so one
   * widget after another — plus a scan of the whole graph table for a count.
   */
  check("stored snapshots are read and filtered by age",
    /readWidgetSnapshots/.test(code) && /WIDGET_FRESH_MS/.test(code));
  check("  a widget with no snapshot, or a failed one, is always refreshed",
    /if \(!s \|\| s\.error\) return true;/.test(code),
    "a card that has never been computed must not wait half an hour for its first number");
  check("  and the graph scan happens only if something needs refreshing",
    code.indexOf("scanGraphEdges()") > code.indexOf("if (all.length === 0)"),
    "scanning the whole table for a count nothing will use was a cost of its own");
}

console.log("\na phase finishing early does not finish the pass");
{
  /**
   * The phases share one function body. A `return` inside one ends the whole
   * invocation and silently skips everything after it — the notification
   * feeds, the pull request pass, the summary. That was written once during
   * this change and caught before it shipped; this keeps it caught.
   */
  const body = code.slice(code.indexOf("export async function handler"));
  const returns = (body.match(/^\s*return;\s*$/gm) ?? []).length;
  check("no bare return inside the pass", returns === 0, returns);
  check("  a phase with nothing to do throws its own quiet sentinel",
    /throw new NothingToDo\(\)/.test(code)
      && /!\(err instanceof NothingToDo\)/.test(code));
}

console.log("\nthe pull request walk is paced, and reminders cannot be starved");
{
  check("the walk of every open pull request is not done every pass",
    /PR_NUDGE_EVERY_MS/.test(code) && /PR_SNAPSHOT_FRESH_MS/.test(code));

  /**
   * The Pull requests tab also writes the snapshot whenever it loads. Pacing
   * reminders off the snapshot's age would let somebody with the tab open keep
   * it fresh and stop reminders being sent at all.
   */
  check("  reminders are paced by their own marker, not the snapshot the tab writes",
    /readPrNudgeMarker/.test(code) && /markPrNudgePass/.test(code),
    "an open tab would otherwise starve reminders indefinitely");
  check("  and only the snapshot-only case reads the snapshot's age",
    /prSettings\.remindersEnabled\s*\?\s*await readPrNudgeMarker/.test(code));
}

console.log("\na warmed view still expires");
{
  /**
   * Every save set a 48-hour expiry, and the warm re-saved stale rows every
   * thirty minutes — so warming pushed the expiry out forever and no My work
   * view ever went away. One opened once, weeks ago, was still costing a scan
   * of the activity table twice an hour.
   */
  check("the warm refreshes contents but keeps the expiry",
    /saveView\(row\.kind, await buildShipped\([^)]*\), \{ keepExpiry: row\.ttl \}\)/.test(code));
  check("  saveView honours it",
    /ttl: opts\.keepExpiry \?\?/.test(views));
  check("  rows already past their expiry are not warmed back to life",
    /r\.ttl <= now/.test(views),
    "DynamoDB deletes expired rows lazily, so they can still come back from a scan");

  /**
   * Which makes a person reading the view the only thing that keeps it alive —
   * so the read has to extend it, or a view used daily goes cold every two days.
   */
  check("reading a view extends its life", /void touchView\(key, stored\.ttl\)/.test(me));
  check("  at most once a day, not on every load",
    /currentTtl - now > 24 \* 3600\) return;/.test(views));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
