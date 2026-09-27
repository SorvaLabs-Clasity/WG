// Drives the real frontend as each e2e/harness-server.ts person; see e2e/run.sh.
// Drive the real frontend as each harness person and record what renders.
// Usage: node render.mjs <sessions.json> <outDir> [baseUrl]
import { pathToFileURL } from "node:url";
// playwright-core is not a repo dependency. PLAYWRIGHT_CORE may point at an
// install elsewhere (its package directory); otherwise it must resolve here.
const { chromium } = process.env.PLAYWRIGHT_CORE
  ? await import(pathToFileURL(`${process.env.PLAYWRIGHT_CORE}/index.mjs`).href)
  : await import("playwright-core");
import fs from "node:fs";
import path from "node:path";

const [, , sessionsFile, outDir, only, base = "http://localhost:5273"] = process.argv;
const { sessions, mode } = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));

const ROUTES = [
  "/my-work", "/analytics", "/aws", "/alarms", "/access", "/dependencies",
  "/dependencies?view=updates", "/dependencies?view=notifications",
  "/graph", "/pulls", "/who-knows", "/activity", "/admin",
];
// Views inside a page, reached by clicking — the ones that fetch their own data.
const CLICKS = {
  "/activity": ["Statistics", "Important events", "GitHub", "Costs", "Feed"],
  "/alarms": ["Groups", "Alarms"],
  "/admin": ["People", "Presets", "Audit"],
};
const NAV = ["/my-work", "/analytics", "/aws", "/alarms", "/access", "/dependencies", "/graph", "/pulls", "/who-knows", "/activity", "/admin"];
const ERROR_TEXT = /something went wrong|unexpected error|failed to load|could not be read|permission_required|is limited to the|ask to be added to|has not granted you any permissions|you have not been given access|not open to you|is restricted|TypeError|undefined is not/i;

const browser = await chromium.launch({ channel: "chrome", headless: true });
const report = { mode, people: {} };

for (const [login, token] of Object.entries(sessions).filter(([l]) => !only || l === only)) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.addInitScript(([t, l]) => {
    sessionStorage.setItem("gh_hub_token", t);
    localStorage.setItem("gh_hub_user", JSON.stringify({ login: l, avatarUrl: "" }));
  }, [token, login]);
  const page = await ctx.newPage();

  let current = "";
  const person = { nav: [], pages: {}, apiRequests: 0 };
  report.people[login] = person;
  const rec = () => (person.pages[current] ??= { failed: [], console: [], crashes: [], text: [] });

  page.on("request", q => { if (new URL(q.url()).pathname.startsWith("/api/")) person.apiRequests++; });
  page.on("response", async r => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith("/api/") || r.status() < 400) return;
    let code = "";
    try { const b = await r.json(); code = [b.code, b.permission, (b.error ?? "").slice(0, 90)].filter(Boolean).join(" | "); } catch {}
    rec().failed.push(`${r.status()} ${u.pathname}${u.search} ${code}`);
  });
  page.on("console", m => { if (m.type() === "error") rec().console.push(m.text().slice(0, 200)); });
  page.on("pageerror", e => rec().crashes.push(String(e.message).slice(0, 200)));

  const settle = async () => {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  };
  const shot = async name => {
    const dir = path.join(outDir, login);
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${name.replace(/[/?=]+/g, "_").replace(/^_/, "") || "home"}.png`), fullPage: false });
  };
  const probeText = async () => {
    const body = await page.locator("body").innerText().catch(() => "");
    const hits = body.split("\n").map(s => s.trim()).filter(s => s && ERROR_TEXT.test(s));
    rec().text.push(...[...new Set(hits)].slice(0, 6).map(s => s.slice(0, 160)));
  };

  // Home: where the app sends this person, and which tabs the nav offers.
  current = "(home)";
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await settle();
  person.landedOn = new URL(page.url()).pathname;
  // The section line, by its labels — it is not plain links.
  const LABELS = ["My work", "Overview", "AWS", "Alarms", "Access", "Vulnerabilities", "Repos", "Pull requests", "Who knows", "Activity", "Admin"];
  const header = await page.locator("header, nav").first().innerText().catch(() => "");
  const lines = header.split("\n").map(s => s.trim().toLowerCase());
  person.nav = LABELS.filter(l => lines.includes(l.toLowerCase()));
  await probeText(); await shot("home");

  for (const route of ROUTES) {
    current = route;
    rec();
    await page.goto(base + route, { waitUntil: "domcontentloaded" });
    await settle();
    await probeText(); await shot(route);
    for (const label of CLICKS[route] ?? []) {
      const btn = page.getByRole("button", { name: new RegExp(`^${label}`, "i") }).first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      current = `${route} › ${label}`;
      rec();
      await btn.click().catch(() => {});
      await settle();
      await probeText(); await shot(`${route}-${label}`);
    }
  }
  await ctx.close();
}
await browser.close();
const file = path.join(outDir, "report.json");
const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { people: {} };
Object.assign(prior.people, report.people); prior.mode = mode;
fs.writeFileSync(file, JSON.stringify(prior, null, 2));
console.log("wrote", path.join(outDir, "report.json"));
