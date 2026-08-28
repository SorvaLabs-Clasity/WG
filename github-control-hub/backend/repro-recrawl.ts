/**
 * Regression test: one recrawl at a time, and one an hour.
 *
 * A full recrawl re-reads every repository, team and member and spends the
 * organization's shared GitHub budget doing it. Two people pressing the button
 * ten minutes apart is waste; two pressing it at once is waste plus two writers
 * racing over the same table.
 *
 * The state behind both answers used to be `mutation.isPending` in one
 * component on one machine: it vanished on a tab switch and nobody else ever
 * saw it, so "is a recrawl happening" had as many answers as there were open
 * windows.
 */
import * as fs from "node:fs";
import {
  recrawlState, refusalReason, RECRAWL_COOLDOWN_MS, RUN_ASSUMED_DEAD_MS, SCHEDULE_ACTOR,
} from "./src/services/recrawlWindow";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const NOW = Date.parse("2026-08-27T22:40:00.000Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

(async () => {

  // ── the hour ────────────────────────────────────────────────────────
  {
    console.log("\nat most one an hour, across everybody");

    check("nothing has ever run, so anybody may start one",
      recrawlState({}, NOW).allowed);
    check("  and there is no number to show",
      recrawlState({}, NOW).minutesSinceLast === null);

    // The example the whole feature was described by: the nightly walk ran at
    // 10pm, somebody tries at 10:40pm.
    const s = recrawlState({ lastAttemptAt: at(40) }, NOW);
    check("forty minutes after a walk, it is refused",
      !s.allowed, s);
    check("  saying how long ago that walk was",
      s.minutesSinceLast === 40, s.minutesSinceLast);
    check("  and how many minutes are left",
      s.waitMinutes === 20, s.waitMinutes);
    check("  in one sentence carrying both numbers",
      /40 minutes ago/.test(refusalReason(s)!) && /in 20 minutes/.test(refusalReason(s)!),
      refusalReason(s));

    check("an hour and a minute later it is allowed again",
      recrawlState({ lastAttemptAt: at(61) }, NOW).allowed);
    check("  and nothing is refused",
      refusalReason(recrawlState({ lastAttemptAt: at(61) }, NOW)) === null);

    // Exactly on the hour is allowed: the boundary belongs to the person
    // waiting, not to the cooldown.
    check("exactly on the hour is allowed",
      recrawlState({ lastAttemptAt: at(60) }, NOW).allowed);

    // Measured from the *start* of the last walk. From its end, a walk taking
    // eight minutes would put the next one 68 minutes out and the number
    // somebody was shown would not match the clock they watched.
    const svc = fs.readFileSync(`${__dirname}/src/services/recrawlWindow.ts`, "utf8");
    check("  counted from when the last walk started, not finished",
      /lastAttemptAt/.test(svc) && !/RECRAWL_COOLDOWN_MS - .*lastSuccess/.test(svc));
    check("the window is an hour", RECRAWL_COOLDOWN_MS === 3_600_000);
  }

  // ── the nightly walk counts ─────────────────────────────────────────
  {
    console.log("\nthe scheduled walk is a recrawl like any other");

    const agg = { lastAttemptAt: at(40), startedBy: SCHEDULE_ACTOR };
    check("a manual attempt after the nightly one waits",
      !recrawlState(agg, NOW).allowed && recrawlState(agg, NOW).waitMinutes === 20);

    // The aggregator writes lastAttemptAt on every path, which is what makes
    // the scheduled walk count without anything special being done for it.
    const agr = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");
    check("  because both callers go through the same stamp",
      /lastAttemptAt: new Date\(\)\.toISOString\(\)/.test(agr));
    check("  and the schedule names itself",
      /startedBy: string = SCHEDULE_ACTOR/.test(agr));

    // The scheduled walk is never blocked by the cooldown: it is the pass that
    // catches missed webhooks, and delaying that a day to save one crawl is the
    // wrong trade. The gate lives in the route, which the Lambda never calls.
    const route = fs.readFileSync(`${__dirname}/src/routes/graph.ts`, "utf8");
    const handler = fs.readFileSync(`${__dirname}/src/jobs/aggregateHandler.ts`, "utf8");
    check("  but is not itself blocked by the cooldown",
      /recrawlState\(before\)/.test(route) && !/recrawlState|refusalReason/.test(handler),
      "skipping reconciliation to save one crawl delays it by a day");
  }

  // ── one at a time ───────────────────────────────────────────────────
  {
    console.log("\nwhile one is running, every screen says so");

    const s = recrawlState({ runningSince: at(2), startedBy: "roni", lastAttemptAt: at(2) }, NOW);
    check("a walk in progress is reported as running", s.running);
    check("  naming who started it", s.startedBy === "roni");
    check("  and refusing a second one",
      !s.allowed && /already running/.test(refusalReason(s)!), refusalReason(s));

    // The flag is cleared when a walk ends, including when it fails. What it
    // cannot survive is the process disappearing: the Lambda hitting its
    // timeout, or somebody closing the desktop app mid-walk.
    check("a run older than the ceiling is assumed dead",
      !recrawlState({ runningSince: at(21) }, NOW).running,
      "otherwise every screen says recrawling forever and the button never returns");
    check("  the ceiling is past the Lambda's own 15-minute timeout",
      RUN_ASSUMED_DEAD_MS > 15 * 60_000,
      "a slow but living walk must never be declared dead while it is still writing");
    check("  and an unparseable value is treated as no run",
      !recrawlState({ runningSince: "not a date" }, NOW).running,
      "the alternative locks the button on a value nothing can clear");

    const agr = fs.readFileSync(`${__dirname}/src/jobs/graphAggregator.ts`, "utf8");
    check("the flag is cleared however the walk ends",
      /finally \{[\s\S]{0,400}?runningSince: undefined/.test(agr),
      "a throw that skips the clear leaves the organization stuck at 'recrawling'");
  }

  // ── how it reaches the screen ───────────────────────────────────────
  {
    console.log("\nthe answer is decided once, on the server");

    const route = fs.readFileSync(`${__dirname}/src/routes/graph.ts`, "utf8");
    const btn = fs.readFileSync(`${__dirname}/../frontend/src/components/RecrawlButton.tsx`, "utf8");

    check("the status endpoint sends the decision, not the raw timestamps",
      /recrawl: recrawlState\(graphAggregation\)/.test(route),
      "two copies of the rule is two chances for the button to disagree with the server");
    check("  and the button reads it rather than working it out",
      /recrawl\?\.running/.test(btn) && /recrawl\?\.allowed === false/.test(btn)
        && !/60 \* 60 \* 1000|3_600_000/.test(btn));

    // isPending is still needed for the seconds between the click and the
    // server admitting it started, but it is no longer the only source.
    check("  local pending state no longer stands alone",
      /recrawl\?\.running \|\| trigger\.isPending/.test(btn),
      "isPending vanished on a tab switch and was invisible to everyone else");

    // 429 is the honest code for a rate limit, but this client turns any 429
    // into a GitHub RateLimitError and raises a global banner saying GitHub's
    // limit was hit. Different thing, untrue here, and alarming.
    check("a refusal does not masquerade as a GitHub rate limit",
      /return res\.status\(409\)/.test(route) && !/status\(429\)/.test(route));

    // One button, used twice. Two hand-written copies of the same action with
    // the same warning is how the rules come to depend on which tab you are on.
    for (const page of ["AccessPage", "AnalyticsPage"]) {
      const src = fs.readFileSync(`${__dirname}/../frontend/src/pages/${page}.tsx`, "utf8");
      check(`  ${page} uses the shared button`,
        /<RecrawlButton/.test(src) && !/confirmRebuild\(/.test(src));
    }
  }

  // ── the dialog tells the truth about the schedule ───────────────────
  {
    console.log("\nand the warning matches the schedule");

    const dialog = fs.readFileSync(`${__dirname}/../frontend/src/lib/confirmRebuild.ts`, "utf8");
    const stack = fs.readFileSync(`${__dirname}/../infra/cdk-stack.ts`, "utf8");

    check("the dialog names the real cadence",
      /every night at 10pm Eastern/.test(dialog));
    check("  which is what the stack schedules",
      /hour: "22"/.test(stack) && /AMERICA_NEW_YORK/.test(stack));
    check("  and no longer says once a day, or six hours",
      !/once a day|every 6 hours|six hours/i.test(dialog),
      "this number has been wrong twice; it is the schedule that decides it");
    check("  it also warns about the hourly limit",
      /At most one an hour/.test(dialog));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
