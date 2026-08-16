/**
 * A security check must never quietly report fewer findings than exist.
 *
 * Run from github-control-hub/backend:  npx tsx repro-dormantadmins.ts
 *
 * `dormant-privileged-users` answers "who has admin on several repositories and
 * has not committed in six months". It costs one commit search per privileged
 * account, and commit search is the smallest budget GitHub gives out — thirty
 * requests a *minute*, against fifteen thousand an hour for everything else. An
 * organization with more privileged accounts than that cannot be read in one
 * pass.
 *
 * The original loop wrapped each search in `catch(e) {}`. Because a finding is
 * only recorded when the search returns zero commits, a dropped error removed
 * that person from the answer entirely — so the widget reported *fewer* dormant
 * admins than existed, with no error and no warning. Just a smaller number, on
 * exactly the check whose whole purpose is to make that number visible. A
 * smaller number reads as an improvement.
 *
 * The rule this pins: a reading that could not be completed is **no reading**,
 * not a short one. The alarm evaluator already treats no reading correctly — it
 * leaves the alarm's state alone rather than resolving it — so refusing here is
 * what stops a rate limit from mailing out an all-clear.
 */
import { readFileSync } from "fs";
import { isAbsence, scanGraphEdges, invalidateEdgeCache } from "./src/services/graphService";
import { __setDocClientForTests } from "./src/utils/dynamo";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/**
 * The loop, extracted so both spellings can be run against the same failures.
 *
 * `search` stands in for GitHub: it either answers with a commit count or
 * throws, and the throwing is the whole subject.
 */
type Search = (login: string) => Promise<{ total_count: number }>;

async function swallowing(users: Array<[string, number]>, search: Search) {
  const found: string[] = [];
  for (const [u, repos] of users) {
    if (repos < 2) continue;
    try {
      const r = await search(u);
      if (r.total_count === 0) found.push(u);
    } catch { /* the bug, preserved so the test can show what it did */ }
  }
  return found;
}

async function refusing(users: Array<[string, number]>, search: Search) {
  const found: string[] = [];
  const unchecked: string[] = [];
  const candidates = users.filter(([, repos]) => repos >= 2);
  for (const [u] of candidates) {
    try {
      const r = await search(u);
      if (r.total_count === 0) found.push(u);
    } catch {
      unchecked.push(u);
    }
  }
  if (unchecked.length > 0) {
    throw new Error(
      `Checked ${candidates.length - unchecked.length} of ${candidates.length} privileged accounts`);
  }
  return found;
}

/** Thirty answers, then the limit — what a real org past the budget does. */
function searchWithBudget(dormant: Set<string>, budget: number): Search {
  let spent = 0;
  return async (login: string) => {
    if (++spent > budget) {
      const err: any = new Error("API rate limit exceeded");
      err.status = 403;
      throw err;
    }
    return { total_count: dormant.has(login) ? 0 : 12 };
  };
}

(async () => {
  // Forty privileged accounts. Five are genuinely dormant, and three of those
  // five sit past the point where the budget runs out.
  const users: Array<[string, number]> = Array.from({ length: 40 },
    (_, i) => [`user${String(i).padStart(2, "0")}`, 5]);
  const dormant = new Set(["user01", "user05", "user32", "user35", "user38"]);

  // ── the bug, demonstrated rather than described ──────────────────────
  {
    const found = await swallowing(users, searchWithBudget(dormant, 30));
    check("the swallowing version returns a shorter list, not an error",
      found.length === 2, found);
    check("  and the three it could not check simply vanish",
      !found.includes("user32") && !found.includes("user35") && !found.includes("user38"), found);
    check("  which reads as two dormant admins when there are five",
      found.length < dormant.size, { reported: found.length, actual: dormant.size });
  }

  // ── what it does now ─────────────────────────────────────────────────
  {
    let threw: Error | null = null;
    let found: string[] | null = null;
    try { found = await refusing(users, searchWithBudget(dormant, 30)); }
    catch (e) { threw = e as Error; }

    check("an incomplete pass is refused, not returned", found === null && threw !== null);
    check("  and says how much of it was read",
      /Checked 30 of 40/.test(threw?.message ?? ""), threw?.message);
  }

  // ── and it still answers when it can ─────────────────────────────────
  {
    const found = await refusing(users, searchWithBudget(dormant, 1000));
    check("with budget to spare, every dormant account is reported",
      found.length === dormant.size && found.every(u => dormant.has(u)), found);
    check("  and nobody active is reported", !found.includes("user00"), found);

    const noneDormant = await refusing(users, searchWithBudget(new Set(), 1000));
    check("an organization with nobody dormant reports nobody",
      noneDormant.length === 0, noneDormant);
  }

  // ── who is even asked about ──────────────────────────────────────────
  {
    let asked = 0;
    const counting: Search = async () => { asked++; return { total_count: 5 }; };
    await refusing([["a", 5], ["b", 1], ["c", 3], ["d", 0]], counting);
    check("only accounts privileged on two or more repositories cost a request",
      asked === 2, asked);

    // The cost is per account, not per repository — the point that decides
    // whether this is affordable at all.
    asked = 0;
    await refusing([["a", 355]], counting);
    check("an account with 355 repositories still costs one request", asked === 1, asked);
  }

  // ── the shape, read from the source ──────────────────────────────────
  //
  // The behaviour above is only real if the shipped loop has it. An empty catch
  // is the exact spelling that caused this, and it is worth failing on by name.
  {
    // Comments stripped first. The scan is looking for a code shape, and this
    // file now contains a comment *quoting* that shape to explain the bug — so
    // reading the raw text finds the explanation and reports it as the offence.
    // A guard that matches its own documentation is a guard that can never pass.
    const strip = (t: string) =>
      t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const src = strip(readFileSync("src/services/graphService.ts", "utf8"));
    const start = src.indexOf('case "dormant-privileged-users"');
    const body = src.slice(start, src.indexOf("break;", start));

    check("the check exists to be read", start > -1);
    check("no error is swallowed in it", !/catch\s*\([^)]*\)\s*\{\s*\}/.test(body),
      body.match(/catch\s*\([^)]*\)\s*\{\s*\}/)?.[0]);
    check("a failed account is collected rather than dropped", /unchecked\.push/.test(body));
    // The condition, not just the throw. `if (false) { throw ... }` leaves the
    // throw right there in the source for a scan to find while never running
    // it, which is exactly what a weakening change looks like.
    check("and an incomplete pass throws",
      /if \(!dormCoverage\.complete\) \{[\s\S]{0,400}?throw new PartialQueryError/.test(body));
    check("  and a complete one returns every stored finding",
      /results\.push\(\.\.\.findingsFrom\(dormSubjects, dormKnown\)\)/.test(body));

    // The two sibling checks read protection per repository and had the same
    // three swallows. They are held to the same rule.
    for (const [name, accumulator, prefix] of [
      ["stale-branch-protections", "unreadable", "sbp"],
      ["protection-bypasses-ranking", "unreadable", "pbr"],
    ] as const) {
      const from = src.indexOf(`case "${name}"`);
      const to = src.indexOf('case "', from + 10);
      const chunk = src.slice(from, to > -1 ? to : undefined);
      check(`${name} collects what it could not read`,
        new RegExp(`${accumulator}\\.push\\(repo\\)`).test(chunk));
      check(`  and refuses a partial answer`,
        new RegExp(`if \\(!${prefix}Coverage\\.complete\\) \\{[\\s\\S]{0,400}?throw new PartialQueryError`).test(chunk));
      // The cap this replaced looked at the first twenty or thirty and said
      // nothing about the rest, which is a sample presented as a survey.
      // Narrowed to the subject list itself: truncating five names into an
      // error message is fine and must not read as the same thing.
      check(`  and no longer truncates the repository list`,
        !/Array\.from\(protectedRepos\)\.slice\(/.test(chunk),
        chunk.match(/Array\.from\(protectedRepos\)\.slice\([^)]*\)/)?.[0]);
      check(`  and takes its subjects from every protected repository`,
        new RegExp(`${prefix}Subjects = Array\\.from\\(protectedRepos\\)`).test(chunk));
      check(`  while a 404 still means "no protection", not a failure`,
        /isAbsence\(e\)/.test(chunk));
    }

    // Nowhere else either — this is a whole-file rule, not one case's.
    check("no empty catch anywhere in the query evaluator",
      !/catch\s*\([^)]*\)\s*\{\s*\}/.test(src),
      src.split("\n").filter(l => /catch\s*\([^)]*\)\s*\{\s*\}/.test(l)));
  }

  // ── absence versus failure ───────────────────────────────────────────
  //
  // The one distinction the whole fix rests on. If this ever answers "absent"
  // to a rate limit, every swallow comes straight back — the error is caught,
  // classified as "no protection", and the repository silently reads compliant.
  {
    check("a 404 is no protection, which is an answer", isAbsence({ status: 404 }));
    check("a rate limit is not an answer", !isAbsence({ status: 403 }));
    check("a server error is not an answer", !isAbsence({ status: 500 }));
    check("a gateway error is not an answer", !isAbsence({ status: 502 }));
    check("a network error with no status is not an answer",
      !isAbsence(new Error("socket hang up")));
    check("nothing at all is not an answer", !isAbsence(undefined) && !isAbsence(null));
    check("a 404 as text is not a status", !isAbsence({ status: "404" }));
  }

  // ── one evaluation per query per pass ────────────────────────────────
  {
    const handler = readFileSync("src/alarms/handler.ts", "utf8");
    check("repeated alarms on one query do not re-run it",
      /queryRuns/.test(handler) && /queryRuns\.set\(key, run\)/.test(handler));
  }

  // ── the graph is read once, not once per check ───────────────────────
  //
  // Every check starts by reading the whole graph. A pass evaluating six query
  // widgets scanned the same table six times for identical bytes, which at a
  // hundred members was the largest line in the DynamoDB bill.
  {
    const src = readFileSync("src/services/graphService.ts", "utf8");
    check("the graph scan is held briefly rather than repeated per caller",
      /edgeCache/.test(src) && /EDGE_CACHE_MS/.test(src));
    check("  and concurrent callers share one in-flight scan",
      /edgeCacheInFlight/.test(src));
    // Behaviour, not text. A regex over the source proves the line exists;
    // this proves a failed scan does not poison every later caller, which is
    // the thing that would take the whole app down until a restart.
    //
    // The env vars are set here rather than by whoever runs the suite: without
    // them `usesDynamo()` is false, the scan reads a local file, and the fake
    // client is never called — so all of this would pass without testing
    // anything. Restored afterwards so no later assertion inherits them.
    const priorActivity = process.env.ACTIVITY_TABLE;
    const priorEdges = process.env.GRAPH_EDGES_TABLE;
    process.env.ACTIVITY_TABLE = "test-activity";
    process.env.GRAPH_EDGES_TABLE = "test-graph-edges";
    invalidateEdgeCache();

    const restore = __setDocClientForTests({
      send: async () => { throw new Error("DynamoDB unavailable"); },
    });
    let firstFailed = false;
    try { await scanGraphEdges(); } catch { firstFailed = true; }
    restore();
    check("  a failed scan is a failure", firstFailed);

    const restore2 = __setDocClientForTests({
      send: async () => ({ Items: [{ pk: "USER#a", sk: "REPO#b", type: "collaborates_on" }] }),
    });
    const after = await scanGraphEdges();
    restore2();
    check("  and does not poison the next one", after.length === 1, after.length);

    // And the hold itself: a second call inside the window must not scan again.
    let scans = 0;
    const restore3 = __setDocClientForTests({
      send: async () => { scans++; return { Items: [{ pk: "USER#a" }] }; },
    });
    invalidateEdgeCache();
    await scanGraphEdges();
    await scanGraphEdges();
    await scanGraphEdges();
    restore3();
    check("  three reads in a row cost one scan", scans === 1, scans);

    invalidateEdgeCache();
    if (priorActivity === undefined) delete process.env.ACTIVITY_TABLE;
    else process.env.ACTIVITY_TABLE = priorActivity;
    if (priorEdges === undefined) delete process.env.GRAPH_EDGES_TABLE;
    else process.env.GRAPH_EDGES_TABLE = priorEdges;
    check("  and a rebuild clearing it",
      /export function invalidateEdgeCache/.test(src)
      && /invalidateEdgeCache\(\)/.test(readFileSync("src/jobs/graphAggregator.ts", "utf8")));
  }

  // ── a check still building says so, and is not reported as broken ────
  {
    const src = readFileSync("src/services/graphService.ts", "utf8");
    check("progress travels with the refusal",
      /readonly covered = 0, readonly total = 0/.test(src));
    const route = readFileSync("src/routes/graph.ts", "utf8");
    check("  and reaches the client with its numbers",
      /QUERY_INCOMPLETE/.test(route) && /covered: error\.covered/.test(route));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
