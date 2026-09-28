// Launch with AWS still connecting, and fail if it turns into a reload loop.
// Usage: node launch.mjs <sessions.json> [person] [ms] [baseUrl]   — see run.sh.
//
// At launch the first request can answer "AWS session expired", which sends
// the browser to /login. From there it used to reload /login several times a
// second — a permission read on the sign-in page got the same answer and sent
// it round again — spending the request limits until the app and sign-in both
// said "Too many requests". One trip to /login is expected; a second is the bug.
import { pathToFileURL } from "node:url";
import fs from "node:fs";
const { chromium } = process.env.PLAYWRIGHT_CORE
  ? await import(pathToFileURL(`${process.env.PLAYWRIGHT_CORE}/index.mjs`).href)
  : await import("playwright-core");

const [, , sessions, who = "fran", ms = "10000", base = "http://localhost:5273"] = process.argv;
const token = JSON.parse(fs.readFileSync(sessions, "utf8")).sessions[who];
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext();
// Seeded once, like a real session: a page load after the app clears the
// token must not get it back.
await ctx.addInitScript(([t, l]) => {
  if (sessionStorage.getItem("__seeded")) return;
  sessionStorage.setItem("__seeded", "1");
  sessionStorage.setItem("gh_hub_token", t);
  localStorage.setItem("gh_hub_user", JSON.stringify({ login: l, avatarUrl: "" }));
}, [token, who]);
const p = await ctx.newPage();
let loginLoads = 0, apiOnLogin = 0, requests = 0;
p.on("load", () => { if (new URL(p.url()).pathname === "/login") loginLoads++; });
p.on("request", r => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/")) return;
  requests++;
  if (new URL(p.url()).pathname === "/login") apiOnLogin++;
});
await p.goto(base + "/");
await p.waitForTimeout(Number(ms));
await b.close();
const ok = loginLoads <= 1 && apiOnLogin === 0;
console.log(`${ok ? "PASS" : "FAIL"}  cold launch: /login loaded ${loginLoads}x, `
  + `${apiOnLogin} app requests from /login, ${requests} app requests in ${ms}ms`);
process.exit(ok ? 0 : 1);
