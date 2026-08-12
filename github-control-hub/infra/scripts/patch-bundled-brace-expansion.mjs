/**
 * Replace the brace-expansion that aws-cdk-lib ships inside its own tarball.
 *
 * CDK bundles its dependencies, so npm installs them from the tarball rather
 * than resolving them — which means `overrides` cannot reach them and
 * `npm audit fix` has nothing to fix. The copy on disk stays vulnerable until
 * AWS republishes.
 *
 * GHSA-rgw5-rvv9-x895: expand() can be driven to exhaust memory or block the
 * event loop. CDK reaches it through minimatch, for ignore patterns and stack
 * selectors, on inputs that are our own file paths — so this is remote from
 * anything an attacker touches. It is patched anyway, because "not reachable
 * today" is an argument that has to be re-made every time the code around it
 * changes, and copying a directory is cheaper than making it again.
 *
 * The replacement is the 5.0.9 that npm installed at the top level, so nothing
 * here downloads anything or invents a patch of its own.
 */
import { existsSync, rmSync, cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(root, "node_modules/aws-cdk-lib/node_modules/brace-expansion");
const source = join(root, "node_modules/brace-expansion");

const version = (p) => {
  try { return JSON.parse(readFileSync(join(p, "package.json"), "utf8")).version; }
  catch { return null; }
};

if (!existsSync(bundled)) {
  console.log("[patch] aws-cdk-lib no longer bundles brace-expansion — nothing to do");
  process.exit(0);
}

const have = version(bundled);
const want = version(source);

if (!want) {
  console.error("[patch] brace-expansion is not installed at the top level; run npm install first");
  process.exit(1);
}

// Compare numerically, so 5.0.10 is not treated as older than 5.0.9.
const older = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i];
  return false;
};

if (!older(have, "5.0.9")) {
  console.log(`[patch] bundled brace-expansion is ${have} — already patched`);
  process.exit(0);
}

rmSync(bundled, { recursive: true, force: true });
cpSync(source, bundled, { recursive: true });
console.log(`[patch] bundled brace-expansion ${have} -> ${version(bundled)}`);
