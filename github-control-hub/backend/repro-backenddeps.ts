/**
 * Every package the backend imports at runtime has to be declared here.
 *
 * This is invisible in development by construction. `npm run dev` resolves from
 * the repository root, where every package any workspace depends on is hoisted,
 * so an undeclared import works perfectly on the machine it was written on.
 *
 * The packaged desktop app does not get that. `bundle:backend-deps` copies
 * *only* `backend/package.json` into `.backend-modules` and installs from it, so
 * anything undeclared is simply absent, and the first call that needs it throws:
 *
 *   Error: Cannot find module '@aws-sdk/client-iam'
 *     at .../backend/dist/services/auditStreamService.js
 *
 * Two of the three found this way were lazy `await import(...)` inside a branch
 * that rarely runs, so the app started, the page rendered, and the failure came
 * only when somebody used that one feature. The audit-log one had never worked
 * in a packaged build at all: its status check threw, the panel read that as
 * "not connected", and it offered to set up a stream that had been running for
 * months. Nobody could tell, because the same code in `npm run dev` was fine.
 *
 * Type-only imports are exempt: `import type` is erased before it ever reaches
 * Node, so nothing is required at runtime.
 *
 * Run:  npx tsx repro-backenddeps.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** Shipped by Node itself; never declared. */
const BUILTIN = new Set([
  "fs", "path", "os", "crypto", "http", "https", "url", "zlib", "stream", "util",
  "events", "child_process", "buffer", "net", "tls", "dns", "assert",
  "querystring", "timers", "worker_threads", "readline", "string_decoder",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * What a package specifier is allowed to look like.
 *
 * Without this the scan matched a template literal several lines below an
 * unrelated `from`, and reported `${req.params.branch}` as a missing package.
 * A guard that invents findings gets switched off, so it only accepts things
 * npm would accept as a name.
 */
const PACKAGE_SPEC = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[^"']*)?$/i;

/** The package a specifier belongs to: `@scope/name/sub` -> `@scope/name`. */
function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

(async () => {
  const pkg = JSON.parse(fs.readFileSync(`${__dirname}/package.json`, "utf8"));
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));

  const runtime = new Map<string, Set<string>>();
  for (const file of walk(`${__dirname}/src`)) {
    // Comments are stripped first: this file's own prose names packages, and a
    // guard that reads its own explanation as an import is worse than none.
    const source = fs.readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

    for (const m of source.matchAll(/(?:^|[^\w$])(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gm)) {
      const spec = m[1];
      if (spec.startsWith(".") || spec.startsWith("node:")) continue;
      if (!PACKAGE_SPEC.test(spec)) continue;

      // `import type { X } from "y"` is erased at compile time.
      const line = source.slice(source.lastIndexOf("\n", m.index!) + 1, m.index! + m[0].length);
      if (/\bimport\s+type\b/.test(line)) continue;

      const name = packageOf(spec);
      if (BUILTIN.has(name)) continue;
      if (!runtime.has(name)) runtime.set(name, new Set());
      runtime.get(name)!.add(path.relative(__dirname, file));
    }
  }

  check("the backend imports something at runtime", runtime.size > 0, runtime.size);

  const undeclared = [...runtime.entries()].filter(([name]) => !declared.has(name));
  check("every package imported at runtime is declared in backend/package.json",
    undeclared.length === 0,
    undeclared.map(([n, files]) => `${n} (${[...files].join(", ")})`));

  // Named so a regression says which. client-iam was the third of these until
  // the enterprise audit stream (its only user) was removed along with it.
  for (const name of [
    "@aws-sdk/client-cloudwatch-logs",  // guardrail collectors and remediators
    "@smithy/core",                     // refreshAwsConfigCache
  ]) {
    check(`  ${name} is declared`, declared.has(name),
      "resolvable from the repository root in dev, absent in the packaged app");
  }

  // ── declared in both lists is the same as not declared ──────────────
  //
  // `npm install --omit=dev` drops a package that appears in *both*
  // `dependencies` and `devDependencies`, the dev entry decides, and the
  // dependency entry does not save it. So a package can be correctly listed as
  // a runtime dependency and still be absent from the packaged app.
  //
  // That is how `@aws-sdk/client-iam` survived being "fixed": it was already in
  // devDependencies, adding it to dependencies changed nothing, and the build
  // went green while the installed app still could not load it.
  {
    const dev = Object.keys(pkg.devDependencies ?? {});
    const both = dev.filter(name => declared.has(name));
    check("no package is listed in both dependencies and devDependencies",
      both.length === 0, both);

    // Cheap to state, and it is the rule the packaging step actually applies.
    check("  because --omit=dev drops those, dependency entry or not",
      true);
  }

  // The packaging step reads this file and nothing else, which is the whole
  // reason an undeclared import survives development.
  {
    const desktop = JSON.parse(fs.readFileSync(`${__dirname}/../desktop/package.json`, "utf8"));
    const bundle = desktop.scripts?.["bundle:backend-deps"] ?? "";
    check("the packaging step still installs from backend/package.json alone",
      bundle.includes("backend") && bundle.includes("package.json"),
      "if this changed, the rule above may no longer be the one that matters");
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
