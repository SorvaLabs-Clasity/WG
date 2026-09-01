import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { isFresh, FRESH_MS } from "./src/services/dependencySnapshot";

/**
 * Regression test: the Vulnerabilities tab paints from a stored answer.
 *
 * Working it out takes an org-wide alert sweep plus two paged status reads. The
 * in-memory cache that already existed does nothing for the case that actually
 * hurt: the first open after launch, in a process that has just started, on an
 * organization where Dependabot has been switched on everywhere.
 *
 * The failure to avoid is subtler than slowness. A stored answer that is served
 * without being refreshed, or one truncated to fit, reports repositories as
 * clean that were never looked at.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const SRC = path.join(__dirname, "src");
const store = fs.readFileSync(path.join(SRC, "services/dependencySnapshot.ts"), "utf8");
const route = fs.readFileSync(path.join(SRC, "routes/dependencies.ts"), "utf8");

(async () => {
  console.log("\nage decides whether it is served as is");
  {
    const now = Date.now();
    check("a recent answer is fresh",
      isFresh({ alerts: [], computedAt: new Date(now - 1000).toISOString() }, now));
    check("  an old one is not",
      !isFresh({ alerts: [], computedAt: new Date(now - FRESH_MS - 1000).toISOString() }, now));
    check("  and nothing stored is not fresh either",
      !isFresh(null, now) && !isFresh({ alerts: [], computedAt: "" } as any, now),
      "an unreadable timestamp must not read as current");
  }

  console.log("\nthe stored answer is served, and refreshed behind the reader");
  {
    check("a stored answer answers immediately",
      /const stored = await readDependencySnapshot\(\);[\s\S]{0,200}res\.json\(/.test(route));
    // Windows measured in characters break on a comment, and this codebase
    // comments heavily. Anchored on the block instead.
    const staleBranch = route.slice(
      route.indexOf("if (!isFresh(stored))"),
      route.indexOf("if (repoFilter) {"));
    check("  a stale one is refreshed without being waited for",
      /void refreshDependencySnapshot/.test(staleBranch),
      "awaiting it would reintroduce exactly the delay this removes");
    check("  and the refresh cannot throw into a caller that is not listening",
      /async function refreshDependencySnapshot[\s\S]{0,300}catch \(err: any\)/.test(store + route));
  }

  console.log("\none sweep, used by both paths");
  {
    // Two copies would be two places for the repository markers and the two
    // status reads to drift, and the drift shows as a repository appearing
    // clean on one path and unwatched on the other.
    check("the route and the refresh share it",
      /async function sweepWholeOrg/.test(route)
        && (route.match(/sweepWholeOrg\(octokit, org\)/g) ?? []).length >= 2,
      route.match(/sweepWholeOrg/g)?.length);
  }

  console.log("\nchanging something invalidates what was stored");
  {
    // The stored answer describes the account as it was, and the point of
    // pressing any of these was to change it.
    const refreshes = (route.match(/void refreshDependencySnapshot\(octokit,/g) ?? []).length;
    check("every write refreshes it", refreshes >= 3, refreshes);
    check("  by recomputing rather than deleting",
      !/deleteDependencySnapshot/.test(route),
      "deleting would make the next open slow again, which is what the store prevents");
  }

  console.log("\na sweep too large to store is refused, not truncated");
  {
    // A tab drawn from half a sweep reports repositories as clean that were
    // never looked at, which is the answer this whole screen exists to avoid.
    check("an oversized payload is not written",
      /> 380_000/.test(store) && /return;/.test(store));
    check("  and says so rather than failing silently",
      /will not fit/.test(store));
    check("  while the rows themselves are never trimmed",
      !/slice\(0, /.test(store),
      "trimming here loses repositories, unlike a widget snapshot backing a count");
  }

  console.log("\nit is stored compressed, because JSON would not fit");
  {
    const alerts = Array.from({ length: 2000 }, (_, i) => ({
      id: `a${i}`, repo: `repo-${i % 300}`, org: "acme", dependency: "lodash",
      severity: "high", cve: "CVE-2020-8203", ecosystem: "npm",
      vulnerable_version: "<4.17.19", patched_version: "4.17.19",
      detected_at: "2026-01-01T00:00:00Z",
    }));
    const raw = Buffer.byteLength(JSON.stringify(alerts));
    const packed = Buffer.byteLength(gzipSync(Buffer.from(JSON.stringify(alerts))).toString("base64"));
    check(`2,000 alerts are ${Math.round(raw / 1024)}KB raw, past DynamoDB's limit`, raw > 400_000, raw);
    check(`  and ${Math.round(packed / 1024)}KB stored, which fits`, packed < 380_000, packed);
    check("  which is why the payload is gzipped", /gzipSync/.test(store) && /gunzipSync/.test(store));
  }

  console.log("\na corrupt row falls back rather than taking the tab down");
  {
    const reader = store.slice(store.indexOf("export async function readDependencySnapshot"));
    check("reading is guarded",
      /catch \(err: any\)/.test(reader) && /return null;/.test(reader));
    check("  and the caller computes when there is nothing stored",
      /if \(stored\) \{/.test(route),
      "no stored answer has to mean compute, not show nothing");
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
