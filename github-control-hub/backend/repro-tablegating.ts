/**
 * Ask about the table you are about to write to, not a different one.
 *
 * `usesDynamo()` reports whether ACTIVITY_TABLE is set. Every service used to
 * call it before touching its own, quite separate table, which is correct only
 * while every process holds both. The graph aggregator's Lambda holds
 * GRAPH_EDGES_TABLE and ORG_CONFIG_TABLE and not ACTIVITY_TABLE, so inside it
 * the answer was always "no". Three failures, all silent, all from that one
 * wrong question:
 *
 *   1. The six-hourly rebuild took the local-development branch and died on
 *      `mkdir /data`. It never wrote an edge on a schedule, ever.
 *   2. The thirty-minute light pass returned immediately having done nothing,
 *      in about fifty milliseconds, which reads exactly like a pass with
 *      nothing to do.
 *   3. `recordGraphAggregation` wrote the "last synced" stamp to an in-memory
 *      object that died with the container, so the Access tab quoted whenever
 *      somebody last pressed Sync by hand while the schedule ran fine beside it.
 *
 * The third is the one worth dwelling on: the rebuild was working by then. Only
 * its record of having worked was lost, so the screen said the opposite.
 *
 * Run:  npx tsx repro-tablegating.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const SRC = path.join(__dirname, "src");
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? walk(path.join(d, e.name))
    : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []);
const strip = (s: string) => s.split("\n")
  .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
  .join("\n");

(async () => {
  const files = walk(SRC);

  // ── every caller asks about a table it actually uses ─────────────────
  {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(SRC, f);
      const code = strip(fs.readFileSync(f, "utf8"));
      if (!/\busesDynamo\(\)/.test(code)) continue;
      // Legitimate only if this file really does read or write ACTIVITY_TABLE.
      // A router that only *chooses* between a stored and an in-memory path is
      // not writing anything itself; the service it delegates to owns the table
      // and is checked on its own line above.
      if (/ACTIVITY_TABLE/.test(code)) continue;
      if (/routes\//.test(rel) && /await import\(/.test(code)) continue;
      offenders.push(rel);
    }
    check("no service gates on ACTIVITY_TABLE while writing a different table",
      offenders.length === 0, offenders);
  }

  // ── and the ones that ask, ask about their own ───────────────────────
  {
    const expected: Record<string, string> = {
      "services/orgConfigService.ts": "ORG_CONFIG_TABLE",
      "services/alarmService.ts": "ALARMS_TABLE",
      "services/alertService.ts": "ALERTS_TABLE",
      "services/widgetService.ts": "WIDGETS_TABLE",
      "services/scannerService.ts": "SCANNERS_TABLE",
      "services/graphService.ts": "GRAPH_EDGES_TABLE",
      "services/graphEdgeService.ts": "GRAPH_EDGES_TABLE",
    };
    for (const [rel, table] of Object.entries(expected)) {
      const code = strip(fs.readFileSync(path.join(SRC, rel), "utf8"));
      check(`  ${rel.split("/").pop()} gates on ${table}`,
        new RegExp(`hasTable\\("${table}"\\)`).test(code)
          && !/\busesDynamo\(\)/.test(code),
        rel);
    }
  }

  // ── the two graph jobs, whose failures were the loudest ──────────────
  {
    const agg = strip(fs.readFileSync(path.join(SRC, "jobs/graphAggregator.ts"), "utf8"));
    const light = strip(fs.readFileSync(path.join(SRC, "jobs/lightGraphRefresh.ts"), "utf8"));
    check("the rebuild is gated on the edges table",
      /process\.env\.GRAPH_EDGES_TABLE/.test(agg) && !/usesDynamo\(\)/.test(agg));
    check("  as is the light pass",
      /process\.env\.GRAPH_EDGES_TABLE/.test(light) && !/usesDynamo\(\)/.test(light));
    check("  and neither writes to a filesystem inside Lambda",
      /AWS_LAMBDA_FUNCTION_NAME/.test(agg) && /AWS_LAMBDA_FUNCTION_NAME/.test(light),
      "a read-only filesystem is where the first of these three surfaced");
  }

  // ── the aggregator's Lambda can reach what it now asks about ─────────
  //
  // The code being right is half of it. If the stack stops passing
  // ORG_CONFIG_TABLE to this function, the sync stamp silently stops updating
  // again and the only symptom is a date on a screen.
  {
    const stack = fs.readFileSync(path.join(__dirname, "..", "infra", "cdk-stack.ts"), "utf8");
    const i = stack.indexOf("-graph-aggregator`,");
    const block = stack.slice(i, i + 1400);
    check("the aggregator's Lambda is given the org-config table",
      /ORG_CONFIG_TABLE:/.test(block),
      "without it the last-synced stamp goes to memory and the Access tab freezes");
    check("  and the edges table it writes",
      /GRAPH_EDGES_TABLE:/.test(block));
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
