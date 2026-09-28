/**
 * Launch must not become a reload loop.
 *
 * At launch, while AWS was still connecting, the app's first request answered
 * "AWS session expired", which sends the browser to /login with a full page
 * load. The permission hook — mounted on every route, the sign-in page
 * included — asked again from /login, got the same answer, and sent it round
 * again: several reloads a second, each one spending the app's request limit
 * and the sign-in route's, until the app and "Sign in to GitHub" both said
 * "Too many requests". Reproduced in the browser by e2e/launch.mjs.
 *
 * Run:  npx tsx repro-loginloop.ts   from github-control-hub/frontend
 */
import fs from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); return; }
  failures++;
  console.log(`  FAIL  ${name}${got === undefined ? "" : `\n        got: ${JSON.stringify(got)}`}`);
}

const client = fs.readFileSync("src/api/client.ts", "utf8");
const hook = fs.readFileSync("src/hooks/usePermissionSet.ts", "utf8");

console.log("sign-in is never a reason to reload sign-in");
{
  const guard = client.slice(client.indexOf("function goToLogin"), client.indexOf("async function handleResponse"));
  check("going to /login does nothing when already there",
    /if \(window\.location\.pathname === "\/login"\) return;/.test(guard));
  const handler = client.slice(client.indexOf("async function handleResponse"));
  const body = handler.slice(0, handler.indexOf("\n}\n"));
  check("  and the response handler only ever goes there through it",
    !/window\.location\.href\s*=/.test(body) && (body.match(/goToLogin\(/g) ?? []).length >= 3,
    body.match(/window\.location\.href\s*=.*$/gm));
}

console.log("\nthe permission answer is only asked for with a session");
{
  const query = hook.slice(hook.indexOf('queryKey: ["me", "permissions"]'));
  check("the query is disabled without a token",
    /enabled: DEMO_MODE \|\| !!getToken\(\)/.test(query.slice(0, 1200)));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
