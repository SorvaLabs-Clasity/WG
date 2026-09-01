import fs from "node:fs";
import path from "node:path";

/**
 * Regression test: every table a Lambda reads is named in its environment.
 *
 * `hasTable` asks whether the variable is set, and every service falls back to
 * an in-memory store when it is not. That fallback is right for local
 * development and catastrophic in Lambda: the code runs, finds an empty store,
 * concludes there is nothing to do, and returns success.
 *
 * It cost real time. The guardrail function evaluates alarms the moment it
 * rewrites findings, and was never given ALARMS_TABLE, so `listAlarms` returned
 * nothing on every invocation. No error, no warning, no log line, because zero
 * alarms is a perfectly ordinary answer. The findings updated instantly and the
 * notification waited for the scheduled evaluator, which reads exactly like the
 * feature not being implemented.
 *
 * So this walks the static import graph from each Lambda's entry point,
 * collects every table the reachable code asks for, and checks the stack names
 * it. Derived from the code rather than from a list, because a list is the
 * thing that was already wrong.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

const SRC = path.join(__dirname, "src");
const STACK = fs.readFileSync(path.join(__dirname, "..", "infra", "cdk-stack.ts"), "utf8");

/** Every module reachable from an entry file by a static or dynamic import. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);

    const body = fs.readFileSync(file, "utf8");
    // Both forms: the Lambdas use `await import()` heavily to keep cold starts
    // down, and an import that only appears at runtime reaches the same code.
    const specs = [
      ...body.matchAll(/from\s+"(\.[^"]+)"/g),
      ...body.matchAll(/import\(\s*"(\.[^"]+)"\s*\)/g),
    ].map(m => m[1]);

    for (const spec of specs) {
      const resolved = path.resolve(path.dirname(file), spec);
      for (const candidate of [`${resolved}.ts`, path.join(resolved, "index.ts")]) {
        if (fs.existsSync(candidate)) { queue.push(candidate); break; }
      }
    }
  }
  return seen;
}

/** Every table the reachable code asks for by name. */
function tablesUsed(files: Set<string>): Set<string> {
  const tables = new Set<string>();
  for (const file of files) {
    // Comments stripped first. A deprecation note reading `hasTable("YOUR_TABLE")`
    // is documentation, and counting it would have this demand an environment
    // variable for a table that does not exist.
    const body = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const m of body.matchAll(/(?:hasTable|tableName)\(\s*"(\w+_TABLE)"/g)) {
      tables.add(m[1]);
    }
  }
  return tables;
}

/** The environment block the stack gives one function. */
function envFor(construct: string): string {
  const at = STACK.indexOf(`new NodejsFunction(this, "${construct}"`);
  if (at < 0) return "";
  const envAt = STACK.indexOf("environment: {", at);
  if (envAt < 0) return "";
  let depth = 0, i = STACK.indexOf("{", envAt);
  for (; i < STACK.length; i++) {
    if (STACK[i] === "{") depth++;
    else if (STACK[i] === "}") { depth--; if (depth === 0) break; }
  }
  return STACK.slice(envAt, i + 1);
}

/**
 * Tables a function reaches only through code it never runs.
 *
 * An entry point pulls in a service that mentions a table on a branch this
 * function cannot take. Each one is listed with the reason rather than the
 * check being loosened, so a genuinely missing table still fails.
 */
const NOT_REACHED: Record<string, Record<string, string>> = {
  GuardrailEnforcer: {
    ALERTS_TABLE: "reached through activityService's shared imports; guardrails raise no security alerts",
    SCANNERS_TABLE: "same: the scanner service is imported for its types, never run here",
    GRAPH_EDGES_TABLE: "the widget row builder covers GitHub checks too; a guardrail subject never asks for them",
    WIDGETS_TABLE: "a guardrail alarm's subject is synthesised from its id, never looked up",
    AUTH_CODES_TABLE: "sign-in only",
    WEBHOOK_DELIVERIES_TABLE: "the webhook path only",
  },
  AlarmEvaluator: {
    AUTH_CODES_TABLE: "sign-in only",
    WEBHOOK_DELIVERIES_TABLE: "the webhook path only",
    ALERTS_TABLE: "written by the scanner path, which the evaluator does not run",
    SCANNERS_TABLE: "same",
    GRAPH_EDGES_TABLE: "withheld in an AWS-only install on purpose; see repro-tablegating.ts",
  },
};

(async () => {
  const LAMBDAS: Array<[string, string]> = [
    ["GuardrailEnforcer", "aws-guardrails/handler.ts"],
    ["AlarmEvaluator", "alarms/handler.ts"],
  ];

  for (const [construct, entry] of LAMBDAS) {
    console.log(`\n${construct} is given the tables its code asks for`);

    const env = envFor(construct);
    check(`  the stack defines it`, env.length > 0, construct);

    const used = tablesUsed(reachable(path.join(SRC, entry)));
    const exempt = NOT_REACHED[construct] ?? {};
    const missing = [...used].filter(t => !env.includes(t) && !(t in exempt)).sort();

    check(`  every table it reaches is named`, missing.length === 0,
      missing.length
        ? `${missing.join(", ")} would fall back to an empty in-memory store and report nothing to do`
        : "");
  }

  console.log("\nthe guardrail function can reach the alarms it evaluates");
  {
    // The specific failure, pinned: this function evaluates alarms the instant
    // it rewrites findings, and the table those alarms live in is the one thing
    // that makes that possible.
    const env = envFor("GuardrailEnforcer");
    check("ALARMS_TABLE is in its environment", env.includes("ALARMS_TABLE"),
      "without it the instant evaluation finds no alarms and silently does nothing");

    const after = fs.readFileSync(path.join(SRC, "aws-guardrails/alarmsAfterSweep.ts"), "utf8");
    check("  and it really does read that table",
      /listAlarms|getGroup/.test(after));

    // Groups live in the same table, so the topic to publish to is unreachable
    // without it even if the alarms were somehow found.
    check("  which is also where the topic to publish to lives",
      /topicArnFor:.*getGroup/s.test(after));
  }

  console.log("\na zero-alarm result is distinguishable from a broken one");
  {
    // The reason this went unnoticed for so long: the handler only logged when
    // something was evaluated, so the failing case printed nothing at all.
    const handler = fs.readFileSync(path.join(SRC, "aws-guardrails/handler.ts"), "utf8");
    check("the sweep says when it evaluated no alarms",
      /alarms\.evaluated === 0/.test(handler) || /evaluated: \$\{alarms\.evaluated\}/.test(handler),
      "logging only the non-zero case makes the broken case indistinguishable from a quiet one");
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
