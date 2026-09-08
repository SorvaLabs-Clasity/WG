/**
 * Searching the feed, where the rows are.
 *
 * The tab used to fetch the newest hundred rows and do everything in the
 * browser. That made the pager stop at page two whatever the table held, and
 * made a search for anything older than those hundred rows return nothing while
 * looking exactly like a search that found nothing.
 *
 * Two things matter here. Filters must run against the whole table, and a
 * search that gave up must say so: "no matches in the rows I read" and "no
 * matches" are different answers, and reporting the second when you mean the
 * first is how somebody concludes a change was never recorded.
 *
 * Run:  npx tsx repro-activitysearch.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { matches, categoryOf, searchMemory, MAX_EXAMINED_PER_REQUEST } from "./src/services/activitySearch";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const row = (over: Partial<any> = {}): any => ({
  id: "1", source: "github", action: "branch.protect", actor: "alice",
  repo: "api", target: "main", details: "protection added",
  timestamp: "2026-08-01T00:00:00Z", ...over,
});

(async () => {
  // ── the filters, one at a time ──────────────────────────────────────
  {
    check("free text matches the actor", matches(row(), { q: "ali" }));
    check("  the action", matches(row(), { q: "protect" }));
    check("  the details", matches(row(), { q: "protection add" }));
    check("  the repository", matches(row(), { q: "api" }));
    check("  and the target", matches(row(), { q: "main" }));
    check("  case-insensitively", matches(row(), { q: "ALICE" }));
    check("  and misses what is not there", !matches(row(), { q: "postgres" }));

    check("source is exact", matches(row(), { source: "github" }) && !matches(row(), { source: "app" }));
    check("repository is a substring, as the box implies",
      matches(row({ repo: "api-service" }), { repo: "api" }));
    check("target matches a pull request number",
      matches(row({ prNumber: 42 }), { target: "42" }));
    check("  and a commit sha", matches(row({ commitSha: "abc123" }), { target: "ABC1" }));

    check("detailed rows can be hidden",
      !matches(row({ detailed: true }), { includeDetailed: false })
      && matches(row(), { includeDetailed: false }),
      "a row with no flag is not a detailed row");
  }

  // ── categories, which must agree with the frontend's own map ────────
  {
    check("aws rows are aws", categoryOf("aws.guardrail.run") === "aws");
    check("  syncs are housekeeping", categoryOf("sync.graph") === "app");
    check("  widgets too", categoryOf("widget.create") === "app");
    check("  branches are organization changes", categoryOf("branch.protect") === "github");
    check("  longest prefix wins",
      categoryOf("template.apply") === "github" && categoryOf("template.create") === "app",
      "applying a template changed repositories; creating one changed a setting");
    check("  and an unknown action is not hidden",
      categoryOf("something.new") === "github",
      "a tab nobody opens is where a new event goes unnoticed");

    // The frontend keeps its own copy, because the two run in different
    // processes. A copy that drifts silently sorts rows into the wrong tab.
    const fe = fs.readFileSync(`${__dirname}/../frontend/src/lib/activityCategories.ts`, "utf8");
    const be = fs.readFileSync(`${__dirname}/src/services/activitySearch.ts`, "utf8");
    // Every prefix contains a dot. Without that the pattern also matches
    // `github: ["app", "github"]` in the sources map, which is a different
    // list entirely and made this compare two things that were never equal.
    const pairs = (s: string) =>
      [...new Set(s.match(/\["[a-z]+\.[a-z]*", "(?:github|aws|app)"\]/g) ?? [])].sort().join("|");
    check("the two copies of the category map agree",
      pairs(fe) === pairs(be),
      "they cannot import each other, so this is what stops them drifting");
  }

  // ── paging, and the difference between empty and unfinished ─────────
  {
    const log = Array.from({ length: 120 }, (_, i) =>
      row({ id: String(i), repo: i % 2 ? "api" : "web", sk: `t${i}` }));

    const p1 = searchMemory(log, {}, 50, 0);
    check("a page holds what was asked for", p1.entries.length === 50);
    check("  and offers a way to continue", !!p1.cursor && p1.exhausted === false);

    const p3 = searchMemory(log, {}, 50, 100);
    check("  the last page says it is the last",
      p3.entries.length === 20 && p3.exhausted === true && !p3.cursor);

    const filtered = searchMemory(log, { repo: "api" }, 50, 0);
    check("filters apply across the whole log, not one page",
      filtered.entries.length === 50 && filtered.entries.every(e => e.repo === "api"),
      "this is the thing the browser could not do");

    const none = searchMemory(log, { q: "nothing-matches-this" }, 50, 0);
    check("  a search that genuinely finds nothing says it finished",
      none.entries.length === 0 && none.exhausted === true,
      "exhausted is what lets the screen say 'none' rather than 'none so far'");
  }

  // ── the shape of the wiring ─────────────────────────────────────────
  {
    const src = fs.readFileSync(`${__dirname}/src/services/activitySearch.ts`, "utf8");
    const svc = fs.readFileSync(`${__dirname}/src/services/activityService.ts`, "utf8");
    const page = fs.readFileSync(`${__dirname}/../frontend/src/pages/ActivityPage.tsx`, "utf8");

    check("a read budget exists, so one request cannot walk a year",
      MAX_EXAMINED_PER_REQUEST > 0 && /examined < MAX_EXAMINED_PER_REQUEST/.test(src));
    check("  and running out is reported as unfinished, not as empty",
      /exhausted/.test(src) && /exhausted: false/.test(src));

    // An exact repository name is a key, not a filter.
    check("a repository filter uses the index rather than reading past it",
      /IndexName: "repo-index"/.test(src),
      "otherwise it reads rows and discards them until the budget runs out");
    check("  falling back when the name is partial",
      /return null;/.test(src) && /searchByRepo\(/.test(src),
      "a partial name is not a partition key and still has to be scanned for");
    check("  and rows with no repository are left out of that index",
      /\.\.\.\(repo \? \{ repo \} : \{\}\)/.test(svc),
      'storing "" would index every sync under one empty key');

    check("the page asks the server for its filters",
      /const serverQuery = useMemo/.test(page) && /q: debouncedSearch/.test(page));
    check("  typing is not a request per keystroke",
      /setTimeout\(\(\) => setDebouncedSearch/.test(page));
    check("  and changing the question starts again from the newest page",
      /setCursors\(\[undefined\]\);/.test(page),
      "a cursor describes a walk of the old query");
  }

  console.log("\na window is a bound on what is read, not on what is kept");
  {
    /**
     * "What did I ship in the last week" walked three thousand rows of
     * organization-wide history newest-first and threw away everything outside
     * the week in JavaScript. Seven days therefore cost exactly what ninety
     * did, and on a busy organization neither came back quickly.
     *
     * Rows live under one partition key with `timestamp#id` as the sort key,
     * so the window belongs in the key condition, where DynamoDB never reads
     * what is outside it.
     */
    const src = fs.readFileSync("src/services/activitySearch.ts", "utf8");

    check("the window reaches the key condition",
      /KeyConditionExpression: "pk = :pk AND sk >= :since"/.test(src),
      "applied after reading, a week costs what a year costs");
    check("  and there is still no bound when none was asked for",
      /KeyConditionExpression: "pk = :pk",/.test(src));

    // The index path and the reader tests inject do not go through that
    // condition, so the same window has to hold when it is applied to a row.
    check("a row older than the window does not match",
      !matches(row({ timestamp: "2026-07-01T00:00:00Z" }), { since: "2026-07-15T00:00:00Z" }));
    check("  one inside it does",
      matches(row({ timestamp: "2026-08-01T00:00:00Z" }), { since: "2026-07-15T00:00:00Z" }));
    check("  the boundary itself is inside",
      matches(row({ timestamp: "2026-07-15T00:00:00Z" }), { since: "2026-07-15T00:00:00Z" }));
    check("  and no window keeps everything",
      matches(row({ timestamp: "2020-01-01T00:00:00Z" }), {}));

    // The caller this was built for.
    const me = fs.readFileSync("src/routes/me.ts", "utf8");
    check("what somebody shipped asks for its own window",
      /searchActivity\(\{ q: login, category: "github", since \}/.test(me));
    check("  and does not re-filter by date afterwards",
      !/Date\.parse\(e\.timestamp\) >= since/.test(me));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
