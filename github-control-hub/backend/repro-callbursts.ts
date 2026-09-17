/**
 * Nothing walks GitHub without a cap, and a burst says so.
 *
 * The App's allowance has been emptied three times by loops nobody could see:
 * a membership walk that asked per person, an uncapped pagination, and a
 * failure retried every five seconds. Each time the symptom was "rate limited
 * and nobody is using the app", which names nothing — and GitHub's rate-limit
 * screen cannot show a secondary limit at all, so it looked like a full budget.
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

console.log("no pagination loop can run without a bound");
{
  /**
   * `for (let page = 1; ; page++)` ends only when a page comes back short.
   * Anything that keeps returning a full page — a proxy serving a cached
   * response, an API that ignores `page`, a team of exactly one hundred —
   * spins forever at one GitHub call per turn.
   */
  const files = fs.readdirSync("./src", { recursive: true, encoding: "utf8" })
    .filter(f => f.endsWith(".ts"))
    // Comments stripped: several of these files explain the pattern they must
    // not use, and a scan that reads the explanation as the code always fails.
    .map(f => [`src/${f}`, fs.readFileSync(`./src/${f}`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")] as const);

  const unbounded = files
    .filter(([, src]) => /for \(let page = 1; ; page\+\+\)/.test(src))
    .map(([name]) => name);

  check("no file paginates without a page cap", unbounded.length === 0, unbounded);

  const admin = fs.readFileSync("./src/routes/admin.ts", "utf8");
  check("  and the admin router's walks share one named cap",
    /const MAX_MEMBER_PAGES = \d+/.test(admin)
      && (admin.match(/page <= MAX_MEMBER_PAGES/g) ?? []).length >= 3,
    (admin.match(/page <= MAX_MEMBER_PAGES/g) ?? []).length);
}

console.log("\na rate limit is never swallowed as 'could not read'");
{
  const admin = fs.readFileSync("./src/routes/admin.ts", "utf8");
  const fn = admin.slice(admin.indexOf("async function membersOfTeam"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  check("membersOfTeam rethrows a 403 or 429",
    /status === 403 \|\| status === 429\) throw err/.test(body),
    "swallowing it returned a partial answer and hid the one thing worth knowing");
  check("  while still answering empty for anything else",
    /return set;/.test(body));
}

console.log("\na burst on the App's token announces itself");
{
  const client = fs.readFileSync("./src/github/client.ts", "utf8");
  check("App-token calls are counted per feature, per minute",
    /function noteAppCall/.test(client) && /BURST_WINDOW_MS/.test(client));
  check("  and the warning names the feature spending it",
    /has made \$\{next\} App-token requests/.test(client),
    "a warning that does not name the culprit sends you looking in the wrong place");
  check("  only for the App's own allowance, not a person's",
    /drawnOn === "app"\) noteAppCall/.test(client),
    "a signed-in person's own grant is theirs to spend and is metered separately");
  check("  and it warns rather than blocks",
    !/throw new Error\(`\[github\] "\$\{feature\}"/.test(client),
    "the graph aggregator is a legitimate bulk pass; stopping it would be worse than the problem");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
