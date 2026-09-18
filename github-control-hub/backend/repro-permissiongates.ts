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
  /**
   * The switch is the file, not this machine's environment.
   *
   * It used to be `PERMISSIONS_ENABLED`, and the desktop build runs this
   * backend inside the user's own Electron process — so the person being
   * restricted owned the process doing the restricting, and not setting the
   * variable, which was the default, turned every gate into `return next()`.
   * A file committed to the organization cannot be unset locally.
   */
  // Scoped to the gate functions. The module still exports a force-*on* helper,
  // which is fine — it can no longer force enforcement off, which was the hole.
  const gateBodies = gate.slice(gate.indexOf("function gate("));
  check("the gate does not consult this machine's environment",
    !/process\.env\.PERMISSIONS_ENABLED/.test(gateBodies),
    "a local variable is a lock whose key sits beside it on a desktop install");

  check("  it asks the permission set instead",
    /accessForSelf\(/.test(gate));

  check("  and an organization with nothing written is still let through",
    /access\.inert/.test(gate) && /return next\(\)/.test(gate),
    "adopting this must stay opt-in; an empty file cannot lock anybody out");

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
   *
   * Exactly one entry, and it earns its place. `webhooks.ts` used to be listed
   * here too, on the reasoning that GitHub's deliveries are HMAC-verified and
   * carry no caller — but there is no `webhooks.ts` in `src/routes/`, so the
   * entry excused nothing and stood ready to excuse everything in a future
   * file that happened to be given that name. An exemption for a file that
   * does not exist is a hole with a comment on it.
   */
  const EXEMPT: Record<string, string> = {
    "auth.ts": "how a session is obtained; gating it on a permission read that needs a session would be a circle",
  };

  check("  and every exempt file actually exists",
    Object.keys(EXEMPT).every(f => fs.existsSync(path.join(dir, f))),
    Object.keys(EXEMPT).filter(f => !fs.existsSync(path.join(dir, f))));

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

  /**
   * Every way a handler can be mounted, including the two that used to slip
   * past: `router.all(...)` answers every verb at once, and `router.route(...)`
   * carries its handlers on the chained `.get`/`.post` after it. A route this
   * regex does not see is a route this file cannot report as ungated.
   */
  const ROUTE_RE = /router\.(get|post|put|delete|patch|all|route)\(/g;

  const files = fs.readdirSync(dir).filter(f => f.endsWith(".ts"));
  const named = new Set<string>();
  const ungated: string[] = [];
  const blanketFiles: string[] = [];

  for (const file of files) {
    if (file in EXEMPT) continue;
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/requireAnyPermission\(([^)]*)\)|requirePermission\("([^"]+)"\)/g)) {
      if (m[2]) named.add(m[2]);
      for (const k of (m[1] ?? "").matchAll(/"([^"]+)"/g)) named.add(k[1]);
    }


    const starts = [...src.matchAll(ROUTE_RE)].map(m => m.index!);
    let considered = 0;
    const fileUngated: string[] = [];

    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : src.length;
      const body = src.slice(start, end);
      const sig = `${file}: ${body.slice(0, body.indexOf("\n")).trim()}`;
      if (Object.keys(ROUTE_EXEMPT).some(k => sig.startsWith(k))) return;
      considered++;

      /**
       * The gate has to be *in front of the handler*, not merely somewhere in
       * the route's text.
       *
       * The old check searched everything between this route and the next one,
       * which passed for a mention in a comment and for a call inside the
       * handler body — where it can no longer refuse anything, because the
       * handler is already running and `next()` means nothing there. So the
       * search is cut at the point the handler function begins: the first
       * `async (` or `(req`, which is where the argument list ends in every
       * route in this codebase.
       *
       * A route whose handler is a named function reaches neither marker and
       * is searched whole, which errs towards accepting rather than towards a
       * false alarm on a shape nobody writes here today.
       */
      const handlerAt = body.slice(body.indexOf("(")).search(/async\s*\(|\(\s*req\b/);
      const args = handlerAt >= 0
        ? body.slice(0, body.indexOf("(") + handlerAt)
        : body;
      if (!/require(Any)?Permission\(/.test(args)) fileUngated.push(sig);
    });

    /**
     * A router-wide gate ahead of the first route, and only where it is
     * genuinely doing all the work.
     *
     * As a blanket "this file is fine" it was too generous: a file with one
     * `router.use` gate and nine routes that each name their own could add a
     * tenth naming nothing, and this would never say so. It now excuses a file
     * only when *every* route in it would otherwise be reported — which is the
     * one arrangement where the blanket really is the gate — and the file is
     * printed, so an exemption granted by accident is visible rather than
     * silent.
     */
    const blanket = src.search(/router\.use\(\s*require(Any)?Permission\(/);
    const blanketFirst = blanket >= 0 && (starts.length === 0 || blanket < starts[0]);
    if (blanketFirst && considered > 0 && fileUngated.length === considered) {
      blanketFiles.push(file);
      continue;
    }
    ungated.push(...fileUngated);
  }

  if (blanketFiles.length) {
    console.log(`  note  a router-wide gate covers every route in: ${blanketFiles.join(", ")}`);
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

  /**
   * The `admin.*` exception this check used to carry is gone: every
   * `admin.*` key now has a route that names it, including the five write
   * permissions `PUT /file` used to collapse into one — `changeClasses` gave
   * each of them a literal `requireAnyPermission(...)` mention on that route
   * for exactly this reason, so the one branch that hands out every other
   * permission is no longer the one branch nothing checks.
   */
  const unused = [...vocabulary].filter(k => !named.has(k));
  check("every permission is named by at least one route",
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

  check("  and does nothing at all where nothing has been written",
    /if \(access\.inert\) return entries;/.test(src),
    "an organization that has not adopted permissions must see an unredacted feed");

  /**
   * The marker crosses the wire, so it is declared twice — once on each side of
   * an HTTP boundary, in packages that cannot import from one another without a
   * shared package existing for the sake of one string.
   *
   * Two declarations are fine; two declarations that can disagree are not. So
   * this reads the value out of each file and compares them to each other
   * rather than each to a literal written here. Changing the marker then means
   * changing both sources and nothing else — and changing one of them fails
   * here, which is the whole point.
   */
  const declared = (text: string, where: string) => {
    const m = text.match(/REDACTED_ACTOR\s*=\s*"([^"]+)"/);
    if (!m) throw new Error(`no REDACTED_ACTOR declaration in ${where}`);
    return m[1];
  };

  const avatar = fs.readFileSync("../frontend/src/components/UserAvatar.tsx", "utf8");
  check("the redacted actor is a constant, spelled once on each side",
    /export const REDACTED_ACTOR =/.test(src) && /export const REDACTED_ACTOR =/.test(avatar));

  const backendMarker = declared(src, "routes/activity.ts");
  const frontendMarker = declared(avatar, "UserAvatar.tsx");
  check("  and the two sides agree on it, so a row redacted server-side renders as withheld",
    backendMarker === frontendMarker,
    `backend ${JSON.stringify(backendMarker)} vs frontend ${JSON.stringify(frontendMarker)} — ` +
    "otherwise the avatar fetches github.com/<marker>.png and draws initials for nobody");

  check("  and it is not a value a real login could collide with",
    /[^a-zA-Z0-9-]/.test(backendMarker),
    `${backendMarker} contains only characters GitHub allows in a username`);
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

    /**
     * `enforced` is what the file says, not what this machine's environment
     * says — the banner used to read a variable that, on a desktop install,
     * the person reading it controlled.
     *
     * It costs one read of `permissions.json` now, where it used to cost none
     * while the flag was off. That read is cached for a minute and is the same
     * one every gate on the page already makes, so it is one draw per minute
     * per user, not one per request. Paying it is the price of an answer that
     * cannot be turned off locally.
     */
    check("  it reports enforcement from the file, not from the environment",
      /enforced: !access\.inert/.test(body) && !/PERMISSIONS_ENABLED/.test(body),
      "a banner reading a local variable reports a setting its reader controls");

    check("    through the caller's own token, like every other permission read",
      /accessForSelf\(req\.user!\.login, req\.user!\.accessToken\)/.test(body));
  }
}

console.log("\nthe client tells \"could not ask\" from \"you may not\"");
{
  /**
   * The server is careful to answer 503 `PERMISSIONS_UNAVAILABLE` rather than
   * 403 when it cannot read the file. The client used to throw that away and
   * answer false to everything, which during a GitHub outage would read as a
   * mass revocation — every tab gone, nothing said. `can()` stays conservative
   * for actions; what must not happen is a section line vanishing in silence.
   */
  const hook = fs.readFileSync("../frontend/src/hooks/usePermissionSet.ts", "utf8");
  check("the hook exposes the failure as its own thing",
    /unavailable/.test(hook) && /data\.failure/.test(hook));

  check("  and can() is still false for an action it could not confirm",
    /if \(data\.failure\) return false;/.test(hook));

  const nav = fs.readFileSync("../frontend/src/components/Navbar.tsx", "utf8");
  check("  and the section line says so instead of emptying",
    /unavailable \|\| canAny\(/.test(nav) && /Permissions unavailable/.test(nav));

  /**
   * `NoAccess` existed and nothing rendered it. Under enforcement somebody
   * holding nothing would get an empty section line and a wall of 403s.
   */
  const router = fs.readFileSync("../frontend/src/router.tsx", "utf8");
  check("NoAccess is actually mounted",
    /import NoAccess from/.test(router) && /<NoAccess \/>/.test(router));

  check("  only when the server says the file was read and names them nowhere",
    /noAccess = !!data && data\.enforced && !data\.inert && !data\.failure/.test(hook)
      && /data\.held\.length === 0/.test(hook));
}

console.log("\nthe section line names permissions that exist");
{
  /**
   * Navbar's `ITEMS` filters the section line by whether *any* of the keys an
   * entry names is held. A typo'd key would fail silently — `can()` would just
   * always answer false for it under enforcement — so this checks every named
   * key against the real vocabulary the same way the routes above are checked.
   */
  const navSrc = fs.readFileSync("../frontend/src/components/Navbar.tsx", "utf8");
  const itemsMatch = navSrc.match(/const ITEMS = \[([\s\S]*?)\n\];/);
  check("Navbar's ITEMS array is found", !!itemsMatch);

  if (itemsMatch) {
    const entries = [...itemsMatch[1].matchAll(/\{\s*label:/g)].length;
    const lists = [...itemsMatch[1].matchAll(/permissions:\s*\[([^\]]*)\]/g)];
    check("  every ITEMS entry names at least one permission", lists.length === entries,
      { entries, named: lists.length });

    const perms = lists.flatMap(m => [...m[1].matchAll(/"([^"]+)"/g)].map(k => k[1]));
    check("  and no entry names an empty list",
      lists.every(m => /"/.test(m[1])));

    const vocabulary = new Set(PERMISSIONS.map(p => p.key));
    const invented = perms.filter(k => !vocabulary.has(k));
    check("  and every permission it names exists in the vocabulary",
      invented.length === 0, invented);

    /**
     * The tabs that are the only route to data gated on some *other* key.
     *
     * Alarms is the reason this check exists: it named `alarms.org.read` alone,
     * while personal alarms and the notification destination live behind it and
     * are reachable nowhere else, so holding `me.alarms.read` and nothing
     * organization-wide hid the only door to your own settings.
     */
    const item = (label: string) => {
      const m = itemsMatch[1].match(
        new RegExp(`\\{\\s*label: "${label}"[^}]*permissions:\\s*\\[([^\\]]*)\\]`));
      return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(k => k[1]) : [];
    };

    const alarms = item("Alarms");
    check("  Alarms is offered on the organization's alarms or on your own",
      alarms.includes("alarms.org.read") && alarms.includes("me.alarms.read"), alarms);

    const activity = item("Activity");
    check("  Activity is offered on any of the three keys that reach the feed",
      ["activity.read.own", "activity.read.app.rows", "activity.read.github"]
        .every(k => activity.includes(k)), activity);

    const overview = item("Overview");
    check("  Overview is offered on overview.read",
      overview.includes("overview.read"), overview);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
