/**
 * The gate, and the assertion that keeps it complete.
 *
 * A permission system is only as good as its least-guarded route, and the
 * failure mode is silence: a route added next year with no gate simply works
 * for everybody, and nothing reports it. `repro-undo.ts` already fails when a
 * write route names no authorization guard — that check exists because the
 * rule-template router once shipped with none and the suite passed by not
 * looking at it. This is the same idea applied to permission keys, in both
 * directions.
 *
 * Run:  npx tsx repro-permissiongates.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import path from "node:path";
import { PERMISSIONS } from "./src/permissions/vocabulary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const gate = fs.readFileSync("./src/middleware/permissionGate.ts", "utf8");

console.log("the gate");
{
  check("nothing enforces unless the flag is on",
    /PERMISSIONS_ENABLED/.test(gate) && /!== "true"/.test(gate),
    "flipping this on is stage 4's job, after the dry-run says who loses what");

  check("  and when it is off, the request simply continues",
    /return next\(\)/.test(gate));

  /**
   * Stage 2's hard contract: a per-request call that omits the caller's token
   * falls into the App-token path, which lists every team in the organization —
   * O(teams) GitHub calls on every request.
   *
   * Stage 3 tightened this further: the only function that can carry the
   * caller's own token at all is `accessForSelf`. `accessForOther` — used for
   * inspecting somebody else, never on the request path — has no token
   * parameter to omit in the first place.
   */
  check("every gate passes the caller's own token, through accessForSelf",
    /accessForSelf\(\s*req\.user!?\.login,\s*req\.user!?\.accessToken/.test(gate),
    "omitting it costs one GitHub call per team, per request");

  check("a refusal names the permission it wanted",
    /PERMISSION_REQUIRED/.test(gate) && /permission:/.test(gate));

  check("  and is a 403, distinguishable from an outage",
    /status\(403\)/.test(gate));

  /**
   * An unreadable file is not a refusal about this person. Saying "you may not"
   * when the truth is "we could not ask" sends somebody to request access they
   * already have.
   */
  check("a failure to read permissions answers 503, not 403",
    /status\(503\)/.test(gate) && /failure/.test(gate));

  check("an AWS-only install passes every gate",
    /inert/.test(gate));
}

console.log("\nthe gate is complete, in both directions");
{
  const dir = "./src/routes";
  /**
   * Files with no permission gate, and why. `auth.ts` is how you get a session
   * at all — gating it on a permission read that needs a session is a circle.
   * `webhooks.ts` is not a user route: GitHub's deliveries are HMAC-verified
   * and carry no caller.
   */
  const EXEMPT: Record<string, string> = {
    "auth.ts": "how a session is obtained; gating it on a session would be a circle",
    "webhooks.ts": "not a user route — HMAC-verified GitHub deliveries, no caller",
  };

  /**
   * One route, not a whole file. `GET /me/permissions` is how the client
   * learns which permissions it has, so gating it on a permission would be the
   * same circle `auth.ts` is exempt from above — except `me.ts` carries plenty
   * of other, correctly-gated routes, so the exemption has to be this precise
   * or it would quietly cover its neighbours too.
   */
  const ROUTE_EXEMPT: Record<string, string> = {
    'me.ts: router.get("/permissions"':
      "how the client learns which permissions it has; gating it on a permission would be a circle",
  };

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts"));
  const named = new Set<string>();
  const ungated: string[] = [];

  for (const file of files) {
    if (file in EXEMPT) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/requireAnyPermission\(([^)]*)\)|requirePermission\("([^"]+)"\)/g)) {
      if (m[2]) named.add(m[2]);
      for (const k of (m[1] ?? "").matchAll(/"([^"]+)"/g)) named.add(k[1]);
    }

    // A router-wide gate ahead of the first route covers the whole file.
    const blanket = src.search(/router\.use\(\s*require(Any)?Permission\(/);
    const firstRoute = src.search(/router\.(get|post|put|delete|patch)\(/);
    if (blanket >= 0 && (firstRoute < 0 || blanket < firstRoute)) continue;

    const starts = [...src.matchAll(/router\.(get|post|put|delete|patch)\(/g)].map(m => m.index!);
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : src.length;
      const body = src.slice(start, end);
      const sig = `${file}: ${body.slice(0, body.indexOf("\n")).trim()}`;
      if (Object.keys(ROUTE_EXEMPT).some(k => sig.startsWith(k))) return;
      if (!/require(Any)?Permission\(/.test(body)) {
        ungated.push(sig);
      }
    });
  }

  check("every route names a permission", ungated.length === 0, ungated.slice(0, 8));

  check("  and every route exemption says why",
    Object.values(ROUTE_EXEMPT).every(reason => reason.length > 20));

  // The other direction. A key nothing names is one somebody can hold and never
  // use; a key named but absent from the vocabulary fails closed and silently.
  const vocabulary = new Set(PERMISSIONS.map(p => p.key));
  const invented = [...named].filter(k => !vocabulary.has(k));
  check("every permission a route names exists in the vocabulary",
    invented.length === 0, invented);

  const unused = [...vocabulary].filter(k => !named.has(k) && !k.startsWith("admin."));
  check("every permission is named by at least one route (admin.* excepted, stage 4)",
    unused.length === 0, unused.slice(0, 12));

  check("  and every exemption says why",
    Object.values(EXEMPT).every(reason => reason.length > 20));
}

console.log("\nthe redaction model is applied, not merely named");
{
  /**
   * `activity.read.app` is a branch over two leaves, and a branch that decides
   * nothing is a promise the admin screen makes and the server does not keep.
   * The gate alone cannot keep it: it answers yes or no to the whole feed,
   * while `.rows` and `.actor` are about what each row says. So this checks
   * both halves — that the feed accepts `.rows` at all, and that the handler
   * reads the permission set rather than trusting the gate to have done it.
   */
  const src = fs.readFileSync("./src/routes/activity.ts", "utf8");
  const feed = src.slice(src.indexOf('router.get("/"'));
  const feedGate = feed.slice(0, feed.indexOf("async ("));

  check("the feed route names activity.read.app.rows",
    /"activity\.read\.app\.rows"/.test(feedGate),
    "somebody granted exactly .rows would otherwise get 403 on the whole feed");

  check("  and still names .own, .actor and .github alongside it",
    ["activity.read.own", "activity.read.app.actor", "activity.read.github"]
      .every(k => feedGate.includes(`"${k}"`)));

  check("activity.ts consults the permission set itself, not just the gate",
    /accessForSelf\(/.test(src) && /permissions\.has\("activity\.read\.app\.actor"\)/.test(src),
    "otherwise everyone past the gate sees full actor names and the two leaves decide nothing");

  check("  and it checks .rows as well, to drop rows it may not redact",
    /permissions\.has\("activity\.read\.app\.rows"\)/.test(src));

  check("  through the caller's own token, the same cached read the gate made",
    /accessForSelf\(\s*login,\s*accessToken\s*\)/.test(src),
    "accessForOther cannot take one, and omitting it is a GitHub call per team");

  check("  and does nothing at all while the flag is off",
    /if \(!PERMISSIONS_ENABLED\(\)\) return entries;/.test(src));

  check("the redacted actor is a constant, spelled once",
    /export const REDACTED_ACTOR = "\(hidden\)";/.test(src));

  const avatar = fs.readFileSync("../frontend/src/components/UserAvatar.tsx", "utf8");
  check("  and the frontend knows the same marker, so it renders as withheld",
    /REDACTED_ACTOR = "\(hidden\)"/.test(avatar),
    "otherwise the avatar fetches github.com/(hidden).png and draws initials for nobody");
}

console.log("\nthe permissions endpoint itself");
{
  /**
   * `GET /me/permissions` is how the client learns which permissions it has.
   * Gating it on a permission is a circle — this asserts the route exists and
   * that it stays deliberately ungated, rather than trusting that nobody adds
   * a guard to it later.
   */
  const meSrc = fs.readFileSync("./src/routes/me.ts", "utf8");
  const idx = meSrc.indexOf('router.get("/permissions"');
  check("GET /me/permissions exists", idx >= 0);

  if (idx >= 0) {
    const rest = meSrc.slice(idx);
    const nextRoute = rest.slice(1).search(/router\.(get|post|put|delete|patch)\(/);
    const body = nextRoute >= 0 ? rest.slice(0, nextRoute + 1) : rest;
    check("  and it carries no requirePermission — the client's own permission list can't be gated on a permission",
      !/require(Any)?Permission\(/.test(body));
  }
}

console.log("\nthe section line names permissions that exist");
{
  /**
   * Navbar's `ITEMS` filters the section line by `can(item.permission)`. A
   * typo'd key would fail silently — `can()` would just always answer false
   * for it under enforcement — so this checks every named key against the
   * real vocabulary the same way the routes above are checked.
   */
  const navSrc = fs.readFileSync("../frontend/src/components/Navbar.tsx", "utf8");
  const itemsMatch = navSrc.match(/const ITEMS = \[([\s\S]*?)\n\];/);
  check("Navbar's ITEMS array is found", !!itemsMatch);

  if (itemsMatch) {
    const entries = [...itemsMatch[1].matchAll(/\{\s*label:/g)].length;
    const perms = [...itemsMatch[1].matchAll(/permission:\s*"([^"]+)"/g)].map(m => m[1]);
    check("  every ITEMS entry names a permission", perms.length === entries,
      { entries, named: perms.length });

    const vocabulary = new Set(PERMISSIONS.map(p => p.key));
    const invented = perms.filter(k => !vocabulary.has(k));
    check("  and every permission it names exists in the vocabulary",
      invented.length === 0, invented);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
