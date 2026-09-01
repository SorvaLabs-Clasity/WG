import fs from "node:fs";
import path from "node:path";

/**
 * Regression test: no component calls a hook after it can return.
 *
 * React counts hooks per render and refuses a render that calls a different
 * number than the last one. A hook placed below an early return is called on
 * some renders and not others, so the component works until the first render
 * that takes the short path, and then the whole screen becomes a stack trace.
 *
 * That is exactly what happened to the GitHub requests tab: a `useMemo` added
 * beneath the loading and error returns. It typechecked, it built, and it
 * crashed on open, because a build cannot see the order hooks run in.
 *
 * The check is brace-matched rather than line-based. A `return` inside a
 * callback is not an early return of the component, and a heuristic that
 * cannot tell the difference reports every component with an event handler.
 */

let failures = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
};

/**
 * Comments and string literals removed.
 *
 * Without this the scan reads prose as code: the very file this check was
 * written against carries a comment saying "that return is conditional", and
 * the word `return` inside it was taken for one. Braces inside strings would
 * throw the depth count off in the same way.
 */
function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

/** Every .tsx under src. */
function files(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) files(full, out);
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** The body of a function, from its opening brace to the matching close. */
function bodyAt(src: string, openIndex: number): { body: string; end: number } | null {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return { body: src.slice(openIndex + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Hooks called after a `return` that belongs to the component itself.
 *
 * Depth is what separates the two cases: a return at the top level of the body
 * ends the render, and one nested inside a callback ends the callback. Only the
 * first kind makes the hooks below it conditional.
 */
function offendingHooks(body: string): string[] {
  let depth = 0;
  let returnedAt = -1;
  const found: string[] = [];

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") depth--;
    else if (depth === 0) {
      if (returnedAt < 0 && /^return[\s(;]/.test(body.slice(i, i + 8))) returnedAt = i;
      const hook = /^(use[A-Z]\w*)\s*\(/.exec(body.slice(i, i + 40));
      // `useX(` at the top level of the body, after the first top-level return.
      if (hook && returnedAt >= 0 && /[\s=(,{]/.test(body[i - 1] ?? " ")) found.push(hook[1]);
    }
  }
  return [...new Set(found)];
}

(async () => {
  console.log("\nno component calls a hook after it can return");

  const offenders: string[] = [];
  for (const file of files("src")) {
    const src = strip(fs.readFileSync(file, "utf8"));
    for (const m of src.matchAll(/\bfunction ([A-Z]\w*)\s*\([^)]*\)[^{]*\{/g)) {
      const open = src.indexOf("{", m.index! + m[0].length - 1);
      const found = bodyAt(src, open);
      if (!found) continue;
      const hooks = offendingHooks(found.body);
      if (hooks.length) {
        offenders.push(`${path.relative("src", file)}: ${m[1]} calls ${hooks.join(", ")}`);
      }
    }
  }

  check("every hook runs on every render", offenders.length === 0,
    offenders.length ? offenders : undefined);

  // A check that can never fail is worth nothing, so this proves it fires.
  console.log("\nand the check would notice one");
  {
    const wrong = strip(`
      const [a, setA] = useState(0);
      if (!data) return null;
      const b = useMemo(() => 1, []);
      return <div />;
    `);
    check("a hook below a top-level return is reported",
      offendingHooks(wrong).includes("useMemo"), offendingHooks(wrong));

    // The case a line-based check gets wrong, and the reason for brace matching.
    const fine = strip(`
      const [a, setA] = useState(0);
      const onClick = () => { if (!a) return; setA(1); };
      const b = useMemo(() => 1, []);
      return <div />;
    `);
    check("  a return inside a callback is not one", offendingHooks(fine).length === 0,
      offendingHooks(fine));
  }

  console.log(failures === 0 ? "\nALL PASS\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
