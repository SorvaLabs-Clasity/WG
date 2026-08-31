import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { createOctokit } from "./src/github/client";
import {
  withFeature, currentFeature, bucketFor, recordRequest, pendingUsage,
  __resetUsageBuffer, hourKey, readUsage, flushUsage, UNATTRIBUTED,
} from "./src/services/githubUsageService";

/**
 * Regression test: the GitHub requests page counts, rather than guesses.
 *
 * The failure this guards against is silent by construction. A new call site
 * works perfectly and is invisible to the counter, so the page keeps rendering
 * and keeps adding up while quietly omitting whatever is actually spending the
 * allowance. Nothing on screen says so.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const ROOT = join(__dirname, "src");
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Fire a request without a network, so only the hook's effect is observed. */
async function attempt(octokit: any, url: string): Promise<void> {
  try {
    await octokit.request(url, { request: { fetch: async () => { throw new Error("no network"); } } });
  } catch { /* the point is the hook, which runs first */ }
}

(async () => {
  console.log("\nevery client is built by the one factory");
  {
    // A `new Octokit()` elsewhere works, spends the allowance, and is invisible
    // here. Three of them were, behind aliased imports, which is why this
    // matches the alias form too.
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === "github/client.ts") continue;
      if (/new\s+[A-Za-z]*Octokit[A-Za-z]*\s*\(/.test(readFileSync(file, "utf8"))) offenders.push(rel);
    }
    check("no client is constructed outside github/client.ts",
      offenders.length === 0, offenders);
  }

  console.log("\na request is counted, and attributed to what asked for it");
  {
    __resetUsageBuffer();
    await withFeature("Nightly access graph rebuild", async () => {
      await attempt(createOctokit("t"), "GET /orgs/acme/repos");
    });
    const [row] = pendingUsage();
    check("the hook fired", pendingUsage().length === 1, pendingUsage());
    check("  under the feature in scope",
      row?.feature === "Nightly access graph rebuild", row);
    check("  against the core allowance", row?.bucket === "core", row);
  }

  console.log("\nthe innermost feature wins");
  {
    __resetUsageBuffer();
    await withFeature("Alarm pass", async () => {
      await withFeature("Renovate pull request search", async () => {
        await attempt(createOctokit("t"), "GET /search/issues");
      });
    });
    const [row] = pendingUsage();
    check("a nested feature reports itself, not its caller",
      row?.feature === "Renovate pull request search", row);
    // Search is metered per minute, so misfiling one as core hides the only
    // budget in the app small enough to run out.
    check("  and search is counted as search", row?.bucket === "search", row);
  }

  console.log("\na client built for one job says so");
  {
    __resetUsageBuffer();
    // The per-subject checks make their calls inline inside a much larger
    // function; naming the client beats wrapping sixty lines of loop.
    await withFeature("Something else", async () => {
      await attempt(
        createOctokit("t", "Per-subject check: stale-branch-protections"),
        "GET /repos/acme/api/rulesets");
    });
    check("the client's own label beats the surrounding scope",
      pendingUsage()[0]?.feature === "Per-subject check: stale-branch-protections",
      pendingUsage());
  }

  console.log("\nnothing is filed under a feature that did not make it");
  {
    __resetUsageBuffer();
    await attempt(createOctokit("t"), "GET /user");
    check("a request with no scope is unattributed, not guessed",
      pendingUsage()[0]?.feature === UNATTRIBUTED, pendingUsage());
    check("  and the scope is empty once the work is done",
      currentFeature() === UNATTRIBUTED, currentFeature());
  }

  console.log("\nbuckets are read from the route");
  {
    check("graphql is its own allowance", bucketFor("/graphql", "POST") === "graphql");
    check("  search is its own allowance", bucketFor("/search/commits") === "search");
    check("  and an absolute search URL is still search",
      bucketFor("https://api.github.com/search/issues") === "search");
    check("  everything else is core", bucketFor("/repos/acme/api/branches") === "core");
  }

  console.log("\ncounts survive being handed to storage");
  {
    __resetUsageBuffer();
    recordRequest("Dependabot alert sweep", "core", 3);
    recordRequest("Dependabot alert sweep", "core", 2);
    check("repeat calls to the same feature accumulate",
      pendingUsage()[0]?.count === 5, pendingUsage());

    // With no table configured the flush is a no-op that still clears, so a
    // desktop session with no AWS behind it does not grow a buffer forever.
    const written = await flushUsage();
    check("  the buffer is emptied by a flush", pendingUsage().length === 0, pendingUsage());
    check("  and the flush reports what it took", written === 1, written);
  }

  console.log("\nan hour is a row, and the window is a range of them");
  {
    const at = new Date("2026-08-31T14:37:00Z");
    check("the hour key is the clock hour", hourKey(at) === "2026-08-31T14", hourKey(at));
    const w = await readUsage(3, at);
    check("  three hours asks for three rows", w.hours.length === 3, w.hours);
    check("    oldest first", w.hours[0] === "2026-08-31T12", w.hours);
    check("    ending at the current partial hour",
      w.hours[2] === "2026-08-31T14", w.hours);
    // "Nothing recorded" and "nothing happened" are different answers, and the
    // page has to say which one it is showing.
    check("  an unreadable or empty window says it is empty", w.empty === true, w.empty);
  }

  console.log("\nthe features that spend are the ones that are labelled");
  {
    // Each of these makes GitHub requests on a schedule or on a press. An
    // unlabelled one shows up as "Unattributed", which is honest but useless.
    const want = [
      ["services/dependencyService.ts", "Dependabot alert sweep"],
      ["services/renovateService.ts", "Renovate pull request search"],
      ["services/prNudgeService.ts", "Open pull request walk"],
      ["services/scannerService.ts", "Scanner run"],
      ["services/repoDetailsService.ts", "Repository detail page"],
      ["jobs/lightGraphRefresh.ts", "Light access graph refresh"],
      ["jobs/graphAggregator.ts", "Nightly access graph rebuild"],
      ["jobs/graphAggregator.ts", "Full GitHub recrawl"],
      ["routes/expertise.ts", "Expertise lookup"],
      ["services/graphService.ts", "Per-subject check: stale-branch-protections"],
      ["services/graphService.ts", "Per-subject check: protection-bypasses-ranking"],
      ["services/graphService.ts", "Per-subject check: dormant-privileged-users"],
    ] as const;
    const missing = want.filter(([file, label]) =>
      !readFileSync(join(ROOT, file), "utf8").includes(label));
    check(`all ${want.length} spenders name themselves`, missing.length === 0,
      missing.map(([f, l]) => `${f}: ${l}`));
  }

  console.log("\nthe counters are flushed by every process that makes requests");
  {
    const flushes: Array<[string, string]> = [
      ["server.ts", "startUsageFlushing"],
      ["alarms/handler.ts", "flushUsage"],
      ["jobs/aggregateHandler.ts", "flushUsage"],
      ["webhooks/worker.ts", "flushUsage"],
    ];
    const missing = flushes.filter(([f, fn]) =>
      !readFileSync(join(ROOT, f), "utf8").includes(fn));
    check("a Lambda that spends also writes down what it spent",
      missing.length === 0, missing);

    // Both branches of the aggregator return, and the light one runs every
    // half hour: a flush on only the full path loses most of what it counts.
    const agg = readFileSync(join(ROOT, "jobs/aggregateHandler.ts"), "utf8");
    check("  including the light refresh, which returns early",
      (agg.match(/await flushUsage\(\)/g) ?? []).length === 2,
      (agg.match(/await flushUsage\(\)/g) ?? []).length);
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
