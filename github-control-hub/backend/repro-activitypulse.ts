/**
 * Regression test: the aggregates behind the Activity tab's header.
 *
 * A chart is a claim about a period, and the two ways it lies are drawing a
 * shorter period under a longer heading, and counting rows it happened to read
 * rather than rows that happened. Both are easy here, because the walk is
 * budgeted and a busy organization will exhaust that budget long before it
 * reaches the far end of a month.
 */
import * as fs from "node:fs";
import {
  activityPulse, MAX_EXAMINED_FOR_PULSE, MAX_EXAMINED_PER_REQUEST,
} from "./src/services/activitySearch";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const H = 3_600_000;
const now = Date.now();
const row = (over: Partial<any> & { hoursAgo: number }) => ({
  id: String(Math.random()),
  action: "github.push",
  actor: "alice",
  repo: "acme/api",
  ...over,
  timestamp: new Date(now - over.hoursAgo * H).toISOString(),
});

/** One page containing everything, the way a small feed answers. */
const onePage = (items: any[]) => async () => ({ items, next: undefined });

(async () => {

  // ── it counts the window, not the page ──────────────────────────────
  {
    console.log("\nthe window decides what is counted");

    const p = await activityPulse(168, 28, "UTC", {
      query: onePage([
        row({ hoursAgo: 1 }),
        row({ hoursAgo: 100 }),
        row({ hoursAgo: 400 }),   // outside a 7-day window
      ]),
    });
    check("rows older than the window are excluded", p.total === 2, p.total);
    check("  and the bucket count is what was asked for", p.buckets.length === 28, p.buckets.length);
    check("  with every counted row landing in exactly one bucket",
      p.buckets.reduce((n, b) => n + b.total, 0) === p.total);
  }

  // ── the split is by stream ──────────────────────────────────────────
  {
    console.log("\nthree streams, counted apart");

    const p = await activityPulse(168, 28, "UTC", {
      query: onePage([
        row({ hoursAgo: 1, action: "github.push" }),
        row({ hoursAgo: 2, action: "github.pr_opened" }),
        row({ hoursAgo: 3, action: "aws.guardrail.finding" }),
        row({ hoursAgo: 4, action: "widget.created" }),
      ]),
    });
    check("each row is counted under its own stream",
      p.byCategory.github === 2 && p.byCategory.aws === 1 && p.byCategory.app === 1,
      p.byCategory);
    check("  and the per-bucket split adds up to the same",
      p.buckets.reduce((n, b) => n + b.github + b.aws + b.app, 0) === p.total);
  }

  // ── who and where ───────────────────────────────────────────────────
  {
    console.log("\nthe people and repositories behind the count");

    const p = await activityPulse(168, 28, "UTC", {
      query: onePage([
        row({ hoursAgo: 1, actor: "alice", repo: "acme/api" }),
        row({ hoursAgo: 2, actor: "alice", repo: "acme/api" }),
        row({ hoursAgo: 3, actor: "bob", repo: "acme/web" }),
        // A row with no repository is normal: a sync, a settings change.
        row({ hoursAgo: 4, actor: "bob", repo: "" }),
      ]),
    });
    check("actors are ranked by how much they did",
      p.topActors[0].actor === "alice" && p.topActors[0].count === 2, p.topActors);
    check("  and repositories likewise",
      p.topRepos[0].repo === "acme/api" && p.topRepos[0].count === 2, p.topRepos);
    check("  while a row with no repository is counted in the total, not as one",
      p.total === 4 && !p.topRepos.some(r => r.repo === ""),
      p.topRepos);
  }

  // ── a truncated walk says so ────────────────────────────────────────
  {
    console.log("\nand it never presents a partial read as a period");

    // A feed that never ends: every page hands back another key.
    let served = 0;
    const endless = async () => {
      served += 100;
      return {
        items: Array.from({ length: 100 }, (_, i) => row({ hoursAgo: 1 + i * 0.001 })),
        next: { pk: "ACTIVITY", sk: String(served) },
      };
    };

    const p = await activityPulse(720, 28, "UTC", { query: endless });
    check("the budget stops the walk", p.examined >= 3000, p.examined);
    check("  a budget of its own, larger than the search's",
      MAX_EXAMINED_FOR_PULSE > MAX_EXAMINED_PER_REQUEST,
      "an org writing 500 rows a week passes 3,000 inside a month, and a count that "
      + "stops there reports a plateau as a total");
    check("  and the answer admits it is partial",
      p.exhausted === false,
      "a count of what was read presented as a count of what happened is the lie");
    check("  naming the oldest row it actually reached",
      !!p.oldest,
      "so the header can say where its own edge is");

    // The opposite case: the window ran out before the budget did.
    const complete = await activityPulse(168, 28, "UTC", {
      query: onePage([row({ hoursAgo: 1 }), row({ hoursAgo: 400 })]),
    });
    check("a walk that reaches past the window is complete",
      complete.exhausted === true, complete.exhausted);
  }

  // ── how it is served ────────────────────────────────────────────────
  {
    console.log("\nserved once a minute, not once a request");

    const route = fs.readFileSync(`${__dirname}/src/routes/activity.ts`, "utf8");
    check("the route caches it",
      /PULSE_TTL_MS = 5 \* 60_000/.test(route) && /pulseCache/.test(route),
      "it reads far more rows than a page does, and a room of open apps would each pay");
    check("  keyed on the window, so switching does not serve the other one",
      /pulseCache\.hours === hours/.test(route));
    check("  and the window is bounded",
      /Math\.min\(Math\.max\(Number\(req\.query\.hours\) \|\| 168, 1\), 24 \* 90\)/.test(route),
      "an unbounded hours would walk the whole table on request");

    // Unfiltered on purpose: it is the backdrop the filtered table sits in
    // front of, and one that narrowed with the table would be the table again.
    const search = fs.readFileSync(`${__dirname}/src/services/activitySearch.ts`, "utf8");
    check("the aggregate takes no filters",
      /export async function activityPulse\(\s*\n\s*hours = 168,/.test(search)
        && !/activityPulse\([^)]*ActivityFilters/.test(search));
  }

  // ── the leaderboards count what they claim to ───────────────────────
  {
    console.log("\ncounting people and repositories, not fields");

    const { isPerson } = await import("./src/services/activitySearch");
    for (const [who, want] of [
      ["alice", true], ["Abbot", true],
      ["system", false], ["unknown", false], ["github[system]", false],
      ["dependabot[bot]", false], ["github-actions[bot]", false],
      ["ci-bot", false], ["", false],
    ] as [string, boolean][]) {
      check(`  ${JSON.stringify(who).padEnd(22)} is ${want ? "a person" : "not"}`,
        isPerson(who) === want);
    }

    const p = await activityPulse(168, 28, "UTC", {
      query: onePage([
        row({ hoursAgo: 1, actor: "alice", repo: "acme/api" }),
        // The guardrail engine reuses `repo` for a resource path. Counting
        // those put four Lambdas at the top of "busiest repositories".
        row({ hoursAgo: 2, action: "aws.guardrail.finding", actor: "system", repo: "github-control-hub/lambda/graph-aggregator" }),
        // "*" means organization-wide. It is the one value in this field that
        // names no repository.
        row({ hoursAgo: 3, actor: "bob", repo: "*" }),
      ]),
    });
    check("automation is left out of most active users",
      p.topActors.every(a => a.actor !== "system"), p.topActors);
    check("  an AWS resource path is not a repository",
      !p.topRepos.some(r => r.repo.includes("lambda")), p.topRepos);
    check("  and neither is the everywhere marker",
      !p.topRepos.some(r => r.repo === "*"), p.topRepos);
    check("  while every row still counts toward the total",
      p.total === 3, p.total);
  }

  // ── what Statistics is drawn from ───────────────────────────────────
  {
    console.log("\nthe rest of the picture, from the same walk");

    const p = await activityPulse(168, 28, "UTC", {
      query: onePage([
        row({ hoursAgo: 1, action: "github.push" }),
        row({ hoursAgo: 2, action: "github.push" }),
        row({ hoursAgo: 3, action: "widget.created" }),
        row({ hoursAgo: 200 }),   // the window before
        row({ hoursAgo: 201 }),
        row({ hoursAgo: 900 }),   // beyond both
      ]),
    });

    check("the commonest kinds are ranked",
      p.topActions[0].action === "github.push" && p.topActions[0].count === 2, p.topActions);
    check("  the hour histogram is complete", p.byHour.length === 24);
    check("  and the window is covered day by day, empty ones included",
      p.byDay.length >= 7,
      "a chart built only from days with events draws a quiet week like a busy one");
    check("  each counting every event in the window exactly once",
      p.byHour.reduce((a, b) => a + b, 0) === p.total
        && p.byDay.reduce((a, d) => a + d.count, 0) === p.total,
      { hour: p.byHour.reduce((a, b) => a + b, 0), day: p.byDay.reduce((a, d) => a + d.count, 0), total: p.total });

    check("the window before is counted in the same pass",
      p.previousTotal === 2, p.previousTotal);

    // A partial previous window compared against a complete current one would
    // invent a trend out of where the budget happened to stop.
    let served = 0;
    const endless = async () => {
      served += 100;
      return {
        items: Array.from({ length: 100 }, (_, i) => row({ hoursAgo: 1 + i * 0.001 })),
        next: { pk: "ACTIVITY", sk: String(served) },
      };
    };
    const cut = await activityPulse(720, 28, "UTC", { query: endless });
    check("  and is null when the walk never reached it",
      cut.previousTotal === null,
      "half a previous window against a whole current one is an invented trend");
  }

  // ── in the reader's own hours ───────────────────────────────────────
  {
    console.log("\nan hour somebody recognises");

    // A fixed instant rather than one relative to now, so this asserts the
    // conversion and not the machine's clock. 18:00 UTC is 14:00 in New York
    // during daylight saving.
    const fixed = [{ id: "1", action: "github.push", actor: "alice", repo: "r",
                     timestamp: "2026-08-28T18:00:00.000Z" }] as any[];
    const utc = await activityPulse(24 * 400, 28, "UTC", { query: onePage(fixed) });
    const ny = await activityPulse(24 * 400, 28, "America/New_York", { query: onePage(fixed) });

    check("UTC puts it at 18:00", utc.byHour.findIndex(v => v > 0) === 18);
    check("  and New York at 14:00", ny.byHour.findIndex(v => v > 0) === 14,
      "the whole point of the number is recognising your own afternoon in it");
    check("  with the zone reported, so the label can name it",
      ny.timeZone === "America/New_York");

    // A zone Intl cannot resolve would throw out of the formatter and take the
    // endpoint with it.
    const bad = await activityPulse(168, 28, "Not/AZone", { query: onePage(fixed) });
    check("an unresolvable zone falls back rather than throwing",
      bad.timeZone === "UTC");
  }

  // ── a floor is shown as a floor ─────────────────────────────────────
  {
    console.log("\nsaying so when the count is a floor");

    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/ActivityPage.tsx`, "utf8");
    const pulseUi = fs.readFileSync(`${__dirname}/../frontend/src/components/ActivityPulse.tsx`, "utf8");
    const stats = fs.readFileSync(`${__dirname}/../frontend/src/components/ActivityStats.tsx`, "utf8");

    // A precise-looking number that has quietly stopped rising is worse than a
    // rough one that admits it.
    check("the stream tabs mark a truncated count",
      /!pulse\.exhausted && "\+"/.test(page));
    check("  as does the headline",
      /pulse && !pulse\.exhausted && <span/.test(pulseUi) && /pulse && !pulse\.exhausted && <span/.test(stats));
    check("  and no trend is computed between two floors",
      /if \(prev === null\) return null;/.test(stats),
      "a percentage between two counts that both stopped early is not a percentage");

    // The cache is what makes the larger walk affordable.
    const route = fs.readFileSync(`${__dirname}/src/routes/activity.ts`, "utf8");
    check("the bigger walk is paid for once every few minutes, not per request",
      /PULSE_TTL_MS = 5 \* 60_000/.test(route));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
