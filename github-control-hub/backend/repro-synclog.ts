/**
 * Every refresh, sweep and sync writes a row.
 *
 * The feed answered "what changed" and could not answer "when did we last look".
 * Those are different questions, and the second one is behind almost every
 * report of a page showing zero or stale: nothing recorded that a collection run
 * had happened, so "the graph is empty" and "nobody has synced since Tuesday"
 * were indistinguishable.
 *
 * The failures worth guarding are the ones that produce a plausible-looking log:
 *
 *   - a sync that failed writing a row that reads like success, which is worse
 *     than writing nothing.
 *   - a five-minute job logging every tick, burying real events under a hundred
 *     thousand rows a year saying "nothing was due".
 *   - a logging failure taking down the run it was describing.
 *   - a row with no actor, so "who ran this" cannot be answered.
 *
 * No DynamoDB: ACTIVITY_TABLE is unset, so activityService uses its in-memory
 * fallback.
 */
delete process.env.ACTIVITY_TABLE;

import fs from "fs";
import { logSync, SCHEDULE_ACTOR, getActivity } from "./src/services/activityService";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

(async () => {
  // ── a run records what it did, and who asked ────────────────────────
  {
    await logSync("graph", "alice", {
      details: "Synced from GitHub — 1,200 connections",
      startedAt: Date.now() - 4200,
    });
    const rows = await getActivity();
    const row = rows.find(r => r.action === "sync.graph");

    check("a sync writes a row naming the action", !!row, rows.map(r => r.action));
    check("  attributed to whoever pressed the button", row?.actor === "alice", row?.actor);
    check("  carrying what came back", /1,200 connections/.test(row?.details ?? ""), row?.details);
    check("  and how long it took, so runs can be compared",
      /\(4\.\d s?\)|\(4\.\ds\)/.test(row?.details ?? ""), row?.details);
    check("  not marked as a failure", !row?.failed, row?.failed);
  }

  // ── a failed run does not read as a successful one ──────────────────
  {
    await logSync("compliance", "bob", {
      details: "Scoring failed", failed: true, error: "rate limit exceeded",
    });
    const row = (await getActivity()).find(r => r.action === "sync.compliance");
    check("a failed sync is marked failed", row?.failed === true, row);
    check("  and keeps the reason, which is the only actionable part",
      row?.errorMessage === "rate limit exceeded", row?.errorMessage);
  }

  // ── a scheduled run is attributed, not left blank ───────────────────
  {
    await logSync("alarms", SCHEDULE_ACTOR, { details: "3 alarms evaluated — 1 fired" });
    const row = (await getActivity()).find(r => r.action === "sync.alarms");
    check("a run nobody triggered names the schedule as the actor",
      row?.actor === SCHEDULE_ACTOR, row?.actor);
    check("  rather than an empty actor, which reads as missing data",
      !!row?.actor?.trim());
  }

  // ── logging cannot sink the work it describes ───────────────────────
  //
  // A run that collected everything and then failed to write its log line has
  // still collected everything. Throwing here would lose the result to report
  // the bookkeeping.
  {
    let threw = false;
    try {
      // A details value that cannot be serialised at all. Whatever it does, it
      // must not propagate.
      const hostile: any = { toString() { throw new Error("no"); } };
      await logSync("access", "carol", { details: hostile });
    } catch { threw = true; }
    check("a failure inside logging never propagates to the caller", !threw);
  }

  // ── the frequent jobs are gated on having done something ────────────
  //
  // The alarm evaluator runs every five minutes and the overwhelming majority
  // of ticks evaluate nothing. Asserted against the source, because the cost of
  // getting this wrong is a feed nobody can read and a table nobody wants to
  // pay for.
  {
    const src = fs.readFileSync(`${__dirname}/src/alarms/handler.ts`, "utf8");
    const gate = src.indexOf("didSomething");
    const call = src.indexOf('logSync("alarms"');
    check("the alarm pass decides whether it did anything", gate > 0);
    check("  and only logs after that decision", call > gate, { gate, call });

    const remindersCall = src.indexOf('logSync("reminders"');
    check("  the reminder pass is gated too",
      /if \(summary\.posted > 0 \|\| summary\.failed > 0\)/.test(src)
        && remindersCall > src.indexOf("summary.posted > 0"));

    // The six-hourly one is not gated, deliberately: four rows a day is history
    // rather than noise, and it is the run people ask about.
    const agg = fs.readFileSync(`${__dirname}/src/jobs/aggregateHandler.ts`, "utf8");
    check("the six-hourly graph sync logs every run",
      /logSync\("graph", SCHEDULE_ACTOR/.test(agg) && !/didSomething/.test(agg));
  }

  // ── every refresh endpoint writes one ───────────────────────────────
  //
  // The list is the point: a new refresh button that logs nothing is the whole
  // bug this file exists to prevent, and it is invisible until somebody asks
  // why the feed has a gap.
  {
    const ROUTES: Array<[string, string]> = [
      ["routes/graph.ts", "aggregate + query re-check"],
      ["routes/compliance.ts", "score refresh, all and per-repo"],
      ["routes/access.ts", "access map recompute"],
      ["routes/scanners.ts", "scanner run"],
      ["routes/pulls.ts", "manual reminder pass"],
    ];
    for (const [file, what] of ROUTES) {
      const src = fs.readFileSync(`${__dirname}/src/${file}`, "utf8");
      check(`  ${file} logs its ${what}`, /logSync\(/.test(src));
    }

    // The guardrail sweep is the exception, and writes its own rows directly
    // from the Lambda rather than through logSync — findings, not ticks.
    const gr = fs.readFileSync(`${__dirname}/src/aws-guardrails/handler.ts`, "utf8");
    check('  the guardrail Lambda still writes its own "aws.guardrail" rows',
      /action: "aws.guardrail"/.test(gr));
  }

  // ── a manual press is logged whatever the outcome ───────────────────
  //
  // The gating that keeps the five-minute jobs quiet must never reach a button.
  // Somebody pressing refresh is history even when the answer is "nothing
  // changed" — that is frequently the fact they are trying to establish, and an
  // unlogged press is indistinguishable from nobody having tried.
  {
    const MANUAL: Array<[string, RegExp, string]> = [
      ["routes/graph.ts",         /logSync\("graph"/,      "graph sync"],
      ["routes/graph.ts",         /logSync\("query"/,      "check re-run"],
      ["routes/compliance.ts",    /logSync\("compliance"/, "score refresh"],
      ["routes/access.ts",        /logSync\("access"/,     "access recompute"],
      ["routes/scanners.ts",      /logSync\("scanner"/,    "scanner run"],
      ["routes/pulls.ts",         /logSync\("reminders"/,  "reminder pass"],
      ["routes/awsGuardrails.ts", /aws\.guardrail\.run/,   "guardrail sweep"],
      ["routes/awsGuardrails.ts", /aws\.guardrail\.preview/, "guardrail preview"],
    ];

    for (const [file, pattern, what] of MANUAL) {
      const src = fs.readFileSync(`${__dirname}/src/${file}`, "utf8");
      check(`the manual ${what} logs`, pattern.test(src), file);
    }

    // None of the route files may borrow the gate the scheduled jobs use. A
    // route is only ever reached because somebody asked.
    for (const file of ["graph.ts", "compliance.ts", "access.ts", "scanners.ts", "pulls.ts", "awsGuardrails.ts"]) {
      const src = fs.readFileSync(`${__dirname}/src/routes/${file}`, "utf8");
      check(`  ${file} does not gate a press on having changed something`,
        !/didSomething/.test(src));
    }

    // And both outcomes are recorded, not just the happy one.
    for (const [file, kind] of [
      ["routes/graph.ts", "query"], ["routes/compliance.ts", "compliance"],
      ["routes/scanners.ts", "scanner"], ["routes/pulls.ts", "reminders"],
    ] as const) {
      const src = fs.readFileSync(`${__dirname}/src/${file}`, "utf8");
      const calls = [...src.matchAll(new RegExp(`logSync\\("${kind}"`, "g"))].length;
      check(`  ${file} logs both the success and the failure of its ${kind} run`,
        calls >= 2, calls);
    }

    const gr = fs.readFileSync(`${__dirname}/src/routes/awsGuardrails.ts`, "utf8");
    check("  the guardrail sweep logs its failure as well as its success",
      [...gr.matchAll(/aws\.guardrail\.run/g)].length >= 2);
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
