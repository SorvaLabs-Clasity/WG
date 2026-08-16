/**
 * No component may be declared inside another component's body.
 *
 * Run from github-control-hub/frontend:  npx tsx repro-nestedcomponents.ts
 *
 * React reconciles by element type, and a component declared inside a render is
 * a brand new function — so a new type — on every render. React therefore
 * unmounts the old tree and mounts a fresh one instead of updating in place.
 * The visible consequences, in order of how long they take to notice:
 *
 *   - a controlled text box inside it loses the caret after every character,
 *     because the input it was typed into no longer exists
 *   - component state inside it resets on every parent render
 *   - the whole subtree's DOM is rebuilt on every poll and every keystroke
 *
 * The first of those shipped here: the "Who knows this?" repository box was a
 * nested `RepoInput`, and typing into it dropped focus per letter.
 *
 * This is a source rule rather than a rendering test on purpose. Reproducing the
 * focus loss needs a real DOM and two renders; the cause is a shape that can be
 * read straight off the file, and reading it catches the next one before it is
 * ever rendered.
 *
 * A helper that returns JSX is fine and is the fix — `const row = (p) => <li/>`
 * called as `row(p)` produces the same elements with no new component type.
 * Only capitalised declarations are components, so only those are flagged.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

/** An indented declaration is inside something; at column 0 it is top level. */
const NESTED = /^[ \t]+(?:(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*[(<]|const\s+([A-Z][a-zA-Z0-9]*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>)/;
const JSX = /<[A-Za-z][A-Za-z0-9.]*[\s/>]/;

export interface Offence { file: string; line: number; name: string }

/**
 * Exported so the canary below can run the identical scan over text it controls.
 * A guard that has only ever been pointed at passing input has not been shown to
 * do anything.
 */
export function scan(source: string, file = "<memory>"): Offence[] {
  const lines = source.split("\n");
  const out: Offence[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = NESTED.exec(lines[i]);
    if (!m) continue;
    const name = m[1] ?? m[2];
    // A capitalised nested function is only a component if it builds elements.
    // Looking ahead a little covers a signature broken across several lines.
    const body = lines.slice(i, i + 40).join("\n");
    if (!JSX.test(body)) continue;
    out.push({ file, line: i + 1, name });
  }
  return out;
}

function walk(dir: string, hit: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, hit);
    else if (entry.endsWith(".tsx")) hit.push(full);
  }
  return hit;
}

// ── the canary ────────────────────────────────────────────────────────
// Verifies the scanner detects the shape at all, and that the two legitimate
// shapes it must not flag are left alone. Without this, "no offences" would be
// indistinguishable from a regex that matches nothing.
{
  const bad = [
    "export default function Page() {",
    "  const Row = ({ p }: { p: string }) => (",
    "    <li>{p}</li>",
    "  );",
    "  return <ul>{Row({ p: \"a\" })}</ul>;",
    "}",
  ].join("\n");
  const found = scan(bad);
  check("canary: a nested component is detected",
    found.length === 1 && found[0].name === "Row", found);

  const nestedFunctionKeyword = [
    "export default function Page() {",
    "  function Row({ p }: { p: string }) {",
    "    return <li>{p}</li>;",
    "  }",
    "  return <ul />;",
    "}",
  ].join("\n");
  check("canary: the `function` spelling is detected too",
    scan(nestedFunctionKeyword).length === 1, scan(nestedFunctionKeyword));

  const helper = [
    "export default function Page() {",
    "  const row = (p: string) => <li>{p}</li>;",
    "  return <ul>{[\"a\"].map(row)}</ul>;",
    "}",
  ].join("\n");
  check("a lowercase helper returning JSX is the fix, not an offence",
    scan(helper).length === 0, scan(helper));

  const topLevel = [
    "function Row({ p }: { p: string }) {",
    "  return <li>{p}</li>;",
    "}",
  ].join("\n");
  check("a top-level component is untouched", scan(topLevel).length === 0, scan(topLevel));

  const notAComponent = [
    "export default function Page() {",
    "  const MAX = 10;",
    "  const label = (n: number) => `${n}`;",
    "  return <ul />;",
    "}",
  ].join("\n");
  check("a constant and a string helper are not components",
    scan(notAComponent).length === 0, scan(notAComponent));
}

// ── the repository ────────────────────────────────────────────────────
{
  const files = walk("src");
  check("there are .tsx files to scan", files.length > 0, files.length);

  const offences = files.flatMap(f => scan(readFileSync(f, "utf8"), f));
  check(
    offences.length === 0
      ? `no component is declared inside another (${files.length} files)`
      : "no component is declared inside another",
    offences.length === 0,
    offences.map(o => `${o.file}:${o.line} ${o.name}`),
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
