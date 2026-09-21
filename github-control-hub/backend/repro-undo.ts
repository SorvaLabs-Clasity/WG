/**
 * Tests for what may be undone.
 *
 * The failure this guards against is quiet: an undo that changes nothing but
 * still reports success and still flags the row. In an app whose job is the
 * audit trail, a log that disagrees with reality is the whole product broken,
 * so the rules live in one module and are pinned here.
 */
import {
  undoBlockedReason, isReversible, needsRepoWrite,
  ALLOWED_UNDO_ACTIONS,
} from "./src/services/undoPolicy";
import fs from "node:fs";
import type { ActivityEntry } from "./src/services/activityService";

let failures = 0;

function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const at = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "a1", source: "app", action: "branch.protect", actor: "someone",
  repo: "acme-api", target: "main", timestamp: new Date().toISOString(), ...over,
} as ActivityEntry);

(async () => {
// ── code history is refused, whatever else is true ────────────────────
{
  for (const action of ["github.push", "github.pr_merged", "github.pr_opened", "github.pr_closed"]) {
    const reason = undoBlockedReason(at({ action: action as any, source: "github" }));
    check(`${action} cannot be undone`, !!reason && reason.includes("git operation"), reason);
  }

  // A payload arriving on one of these, a bug, or a tampered row, must not
  // buy its way past the rule.
  const forged = at({
    action: "github.push" as any, source: "github",
    undoPayload: { action: "delete_branch", params: { branch: "main" } },
  });
  check("a push carrying an undo payload is still refused",
    !!undoBlockedReason(forged), undoBlockedReason(forged));

  // Nor may a child smuggle one in.
  const withChild = undoBlockedReason(
    at({ action: "github.push" as any, source: "github" }),
    [at({ id: "c", undoPayload: { action: "delete_branch", params: {} } })],
  );
  check("a push with an undoable child is still refused", !!withChild, withChild);
}

// ── observations of GitHub are refused ────────────────────────────────
{
  const r = undoBlockedReason(at({ action: "branch.create", source: "github" }));
  check("a branch created directly in GitHub is not the app's to undo",
    !!r && r.includes("directly in GitHub"), r);
}

// ── what the app did, it can undo ─────────────────────────────────────
{
  const ok = at({ undoPayload: { action: "delete_protection", params: { branch: "main" } } });
  check("an app action with a known payload is undoable", undoBlockedReason(ok) === null, undoBlockedReason(ok));

  const parent = at({ action: "template.apply", undoPayload: undefined });
  const kids = [at({ id: "c1", undoPayload: { action: "delete_branch", params: {} } })];
  check("a parent with no payload is undoable through its children",
    undoBlockedReason(parent, kids) === null, undoBlockedReason(parent, kids));
  check("  but not when the children have nothing either",
    undoBlockedReason(parent, [at({ id: "c1" })]) !== null);
}

// ── unimplemented operations fail loudly ──────────────────────────────
{
  // The AWS guardrail Lambda writes undo payloads this route has no handler
  // for. Before, they hit `default: break` and reported success.
  const aws = at({ action: "aws.guardrail" as any, repo: "/aws/lambda/thing",
    undoPayload: { action: "logs_restore_retention", params: { days: 1 } } });
  check("an operation with no handler is refused, not silently skipped",
    (undoBlockedReason(aws) ?? "").includes("not supported"), undoBlockedReason(aws));
  check("  and is not counted as reversible", !isReversible(aws));
}

// ── a deleted feature's undos are refused, not silently skipped ───────
{
  // Templates and exclusion lists are gone. Their rows are still in the log and
  // still carry undo payloads, and canUndo in the frontend offers the button on
  // the strength of a payload existing, so this path is reachable by pressing
  // Undo on a template row, and it has to fail rather than report success.
  const { REMOVED_UNDO_ACTIONS, undoRequirement: reqFor } = require("./src/services/undoPolicy");

  for (const action of REMOVED_UNDO_ACTIONS) {
    const row = at({ action: "template.create" as any,
      undoPayload: { action, params: { templateId: "t1" } } });

    const reason = undoBlockedReason(row);
    check(`${action} is refused`, !!reason, reason);
    check(`  and says the feature was removed`,
      (reason ?? "").includes("no longer be undone") && (reason ?? "").includes("removed"), reason);
    check(`  and is not counted as reversible`, !isReversible(row));

    // Absent from the requirements map, so it must inherit the strictest
    // default rather than sailing through with no check.
    const r = reqFor(row);
    check(`  and an absent requirement fails closed`,
      r.repo === "admin" && r.adminTeam === true, r);
  }

  // The allow-list is what denies them; the message only explains the denial.
  const stillAllowed = [...REMOVED_UNDO_ACTIONS].filter(a => ALLOWED_UNDO_ACTIONS.has(a));
  check("no removed operation is still on the allow-list", stillAllowed.length === 0, stillAllowed);
}

// ── permission scope keys on the operation, not the repo field ────────
{
  // AWS rows put a log group name in `repo`; checking GitHub for it would ask
  // about a repository that does not exist.
  const aws = at({ repo: "/aws/lambda/thing", undoPayload: { action: "revert_widget", params: {} } });
  check("a non-repo operation needs no GitHub write check", !needsRepoWrite(aws));

  const branch = at({ repo: "acme-api", undoPayload: { action: "delete_branch", params: {} } });
  check("a branch operation needs write on its repo", needsRepoWrite(branch));

  const { reposByLevel: byLevel } = require("./src/services/undoPolicy");
  const repos = byLevel([
    branch,
    at({ id: "b", repo: "acme-web", undoPayload: { action: "restore_protection", params: {} } }),
    at({ id: "c", repo: "acme-api", undoPayload: { action: "delete_ruleset", params: {} } }),
    aws,
    // An org-wide operation: the row carries a repo, and the operation does not
    // act on it, so it must not be collected as one needing a write check.
    // This was `delete_scanner` until the scanner feature was removed.
    at({ id: "d", repo: "acme-docs", undoPayload: { action: "delete_widget", params: {} } }),
  ]);
  check("every repo an undo would touch is collected, once",
    [...repos.admin, ...repos.push].sort().join() === "acme-api,acme-web", repos);
  check("  an org-wide operation contributes no repo", !repos.admin.includes("acme-docs"), repos);
}

// ── the allow-list and the handlers must not drift ────────────────────
{
  const src = require("fs").readFileSync(require("path").join(__dirname, "src/routes/activity.ts"), "utf8");
  const undoFn = src.slice(src.indexOf("async function executeUndo"));
  const handled = new Set(
    [...undoFn.slice(0, undoFn.indexOf("\n}")).matchAll(/case "([a-z_]+)"/g)].map((m: any) => m[1])
  );
  const missing = [...ALLOWED_UNDO_ACTIONS].filter(a => !handled.has(a));
  check("every allowed operation has a handler", missing.length === 0, missing);
  const extra = [...handled].filter(a => !ALLOWED_UNDO_ACTIONS.has(a));
  check("every handler is on the allow-list", extra.length === 0, extra);
}

// ── deleting a branch must not discard work, however it got there ─────
{
  const { inspectBranchWork, branchWasTouched } = require("./src/services/branchService");
  process.env.GITHUB_ORG = process.env.GITHUB_ORG || "test-org";

  const CREATED = "2026-01-01T00:00:00Z";

  /** Octokit stand-in answering only what inspectBranchWork asks. */
  const fake = (tip: string | null, aheadBy?: number, commitsSince = 0) => ({
    rest: {
      git: {
        getRef: async () => {
          if (tip === null) { const e: any = new Error("Not Found"); e.status = 404; throw e; }
          return { data: { object: { sha: tip } } };
        },
      },
      repos: {
        compareCommitsWithBasehead: async () => {
          if (aheadBy === undefined) throw new Error("no base");
          return { data: { ahead_by: aheadBy } };
        },
        listCommits: async () => ({ data: Array.from({ length: commitsSince }, (_, i) => ({ sha: "c" + i })) }),
      },
    },
  }) as any;

  const look = (o: any, opts: any = {}) => inspectBranchWork(o, "acme-api", "dev",
    { createdFromSha: "abc123", baseBranch: "main", createdAt: CREATED, ...opts });

  const untouched = await look(fake("abc123", 0, 0));
  check("a branch still at its creation commit is deletable", !branchWasTouched(untouched), untouched);

  // Every way a branch can change moves the tip, so one signal covers them all.
  for (const [name, tip, ahead, since] of [
    ["a plain commit",        "def456", 1, 1],
    ["a merge into it",       "def456", 3, 2],
    ["a squash merge",        "def456", 1, 1],
    ["a rebase",              "def456", 2, 2],
    ["a force-push",          "def456", 0, 0],
  ] as [string, string, number, number][]) {
    const w = await look(fake(tip, ahead, since));
    check(`${name} blocks the undo`, branchWasTouched(w), w);
  }

  // Rows written before createdFromSha existed still have to be judged.
  const legacyRebased = await look(fake("def456", 0, 2), { createdFromSha: undefined });
  check("without a recorded SHA, commits landed since creation still block it",
    branchWasTouched(legacyRebased) && legacyRebased.commitsSince === 2, legacyRebased);

  const legacyUnmerged = await look(fake("def456", 3, 0), { createdFromSha: undefined });
  check("  as do unmerged commits", branchWasTouched(legacyUnmerged), legacyUnmerged);

  const legacyClean = await look(fake("abc123", 0, 0), { createdFromSha: undefined });
  check("  and an untouched legacy branch stays deletable", !branchWasTouched(legacyClean), legacyClean);

  // A branch whose work is already in the base loses nothing by being deleted,
  // but it still moved, so the SHA check must be the one that speaks.
  const merged = await look(fake("def456", 0, 0));
  check("a branch whose work was merged away still reports it moved",
    merged.movedSinceCreation && merged.unmergedCommits === 0, merged);

  const gone = await look(fake(null));
  check("an already-deleted branch is a no-op, not an error", gone === null, gone);

  const noBase = await look(fake("def456"), { baseBranch: undefined });
  check("an unusable base leaves the other signals working",
    branchWasTouched(noBase), noBase);

  const noTimestamp = await look(fake("abc123", 0, 9), { createdAt: undefined });
  check("without a creation time, commitsSince is not guessed",
    noTimestamp.commitsSince === 0 && !branchWasTouched(noTimestamp), noTimestamp);
}

// ── undoing needs what doing needed ───────────────────────────────────
{
  const { undoRequirement, needsAdminTeam, reposByLevel } = require("./src/services/undoPolicy");

  // Every operation is listed, so a new one cannot inherit "no checks" by
  // being forgotten.
  const unlisted = [...ALLOWED_UNDO_ACTIONS].filter(a => {
    const r = undoRequirement(at({ undoPayload: { action: a, params: {} } }));
    return r.repo === "admin" && r.adminTeam === true;   // the unknown-op default
  });
  check("every allowed operation has an explicit requirement", unlisted.length === 0, unlisted);

  const req = (a: string) => undoRequirement(at({ undoPayload: { action: a, params: {} } }));

  check("stripping branch protection needs repo admin", req("delete_protection").repo === "admin");
  check("deleting a ruleset needs repo admin", req("delete_ruleset").repo === "admin");
  check("toggling dependabot needs repo admin", req("disable_dependabot").repo === "admin");
  check("deleting a template branch needs repo admin", req("delete_branch").repo === "admin");
  check("recreating a branch only needs push", req("recreate_branch").repo === "push");

  check("reverting a widget needs the admin team", req("revert_widget").adminTeam === true);
  check("  and is not repo-scoped", req("revert_widget").repo === undefined);
  check("  because there is one dashboard, shared by everyone",
    req("delete_widget").adminTeam === true && req("restore_widget").adminTeam === true);

  // Nothing is ungated any more. If something is added that should be, this
  // has to be changed deliberately rather than by forgetting an entry.
  const ungated = [...ALLOWED_UNDO_ACTIONS].filter(a => {
    const r = req(a);
    return !r.repo && !r.adminTeam;
  });
  check("no undo operation is left with no check at all", ungated.length === 0, ungated);
  check("reverting a scanner needs the admin team", req("revert_scanner").adminTeam === true);
  check("  because a scan reads every repo with the app's own credentials",
    req("delete_scanner").adminTeam === true && req("restore_scanner").adminTeam === true);

  // An unknown operation must demand the most, not the least.
  const unknown = undoRequirement(at({ undoPayload: { action: "something_new", params: {} } }));
  check("an unrecognized operation demands both checks",
    unknown.repo === "admin" && unknown.adminTeam === true, unknown);

  check("a template edit anywhere in the group triggers the team check",
    needsAdminTeam([
      at({ id: "a", undoPayload: { action: "delete_branch", params: {} } }),
      at({ id: "b", undoPayload: { action: "revert_template", params: {} } }),
    ]));
  check("  and a group without one does not",
    !needsAdminTeam([at({ id: "a", undoPayload: { action: "delete_branch", params: {} } })]));

  // Admin-team membership says nothing about whether you can touch a given
  // repo, so repos are grouped and asked about individually.
  const grouped = reposByLevel([
    at({ id: "1", repo: "acme-api", undoPayload: { action: "delete_protection", params: {} } }),
    at({ id: "2", repo: "acme-web", undoPayload: { action: "recreate_branch", params: {} } }),
    at({ id: "3", repo: "acme-api", undoPayload: { action: "recreate_branch", params: {} } }),
    at({ id: "4", repo: "/aws/lambda/x", undoPayload: { action: "revert_widget", params: {} } }),
  ]);
  check("repos are grouped by the level each needs",
    grouped.admin.join() === "acme-api" && grouped.push.join() === "acme-web", grouped);
  check("  a repo needing admin is not also asked about for push",
    !grouped.push.includes("acme-api"), grouped);
  check("  non-repo operations contribute no repo",
    !grouped.admin.includes("/aws/lambda/x") && !grouped.push.includes("/aws/lambda/x"), grouped);
}

// ── no write route escapes a gate ─────────────────────────────────────
// The holes found so far were all "this route was never given a check", not
// "this check is wrong". A list of route files and the guard each write must
// name catches the next one at test time rather than in production.
{
  const fs = require("fs"), path = require("path");
  const read = (f: string) => fs.readFileSync(path.join(__dirname, "src/routes", f), "utf8");

  const GUARDED: [string, RegExp, RegExp][] = [
    // Two gates since personal dashboards existed. Creating still asks
    // `refusedWidgetChange`, admin, for the one board everybody sees, while
    // editing and deleting ask `refusedWidgetEdit`, which reads the stored
    // owner first and is the stricter of the two: it refuses somebody else's
    // personal widget outright rather than falling back to the admin gate.
    ["widgets.ts",       /router\.(post|put|delete)\(/g, /refusedWidget(Change|Edit)/],
    ["alerts.ts",        /router\.(post|put|delete)\(/g, /refusedAlertChange/],
    ["config.ts",        /router\.(post|put|delete)\(/g, /refuseUnlessAdmin/],
    // The rule-template router was absent from this list until the August 2026
    // review, which is why it was the one org-wide config router shipping with
    // no authorization at all. It has since been deleted along with the rest of
    // the templates feature, but the lesson stands: a file that is not listed
    // here is not checked, so the list itself is the thing to keep honest, see
    // the completeness assertion below.
    ["awsGuardrails.ts", /router\.(post|put|delete)\(/g, /requireAdmin/],
    // Two gates, because the routes ask different questions. Undo and retry
    // ask whether this person may reverse this particular action; the
    // detailed-logging settings ask whether they are an org admin at all.
    // Either is a real gate; a route naming neither is what this catches.
    ["activity.ts",      /router\.(post|put|delete)\(/g, /denyIfNotPermitted|teamOrPermission/],
    // `refusedForSubject` is a guard too: it runs inside the handler because
    // which team may write depends on what the alarm watches, which is not
    // known until the body or the stored record has been read.
    ["alarms.ts",        /router\.(post|put|delete)\(/g, /requireAdmin|refusedForSubject/],
    // Pausing a stale-pull-request reminder silences it for everyone on that
    // pull request, not just for the person clicking, so it is an org-wide act
    // and gated the same way.
    ["pulls.ts",         /router\.(post|put|delete)\(/g, /teamOrPermission\(login, req\.user!\.accessToken, "control-hub"/],
    // The one router that can grant permissions, so it is the one whose own
    // gating matters most. `requirePermission` is **not** accepted here: it is
    // `return next()` while `PERMISSIONS_ENABLED` is unset, which is the
    // configuration this ships in, so a router whose only guard is a
    // permission gate is a router with no guard at all. The blanket team gate
    // is what this names, and the behavioural check below is what proves it
    // decides something rather than merely being spelled correctly.
    // admin.ts carries two guards, and neither alone is the answer. The team
    // gate is a conditional `router.use` — it decides while PERMISSIONS_ENABLED
    // is unset and steps aside once permissions do, so it is not a blanket this
    // scan can credit. What every write route must name is its own permission.
    // `repro-admin.ts` drives the flag-off half behaviourally.
    ["admin.ts",         /router\.(post|put|delete)\(/g, /require(?:Any)?Permission|requireControlHubAdmin/],
    // Exempted as "read models over the graph" until it was read carefully.
    // PUT /config replaces the rule set the entire organization is scored
    // against, and `{"rules": []}` scores everything 100, an org-wide
    // configuration write sitting in a router nobody was checking, which is
    // exactly the failure the completeness assertion below exists to catch and
    // did not, because an inaccurate exemption reads the same as a correct one.
  ];

  for (const [file, routeRe, guardRe] of GUARDED) {
    const src = read(file);
    const starts = [...src.matchAll(routeRe)].map(m => m.index!);

    /**
     * A router-wide `router.use(guard)` gates everything declared after it.
     *
     * Accepted as an alternative to naming the guard on each route, and only
     * when it precedes the first route, a gate installed halfway down the
     * file leaves everything above it open, which is the same bug as
     * forgetting it. This is the stronger of the two patterns, because a route
     * added later inherits it instead of having to remember it.
     */
    const blanketAt = src.search(new RegExp(`router\\.use\\(\\s*(?:${guardRe.source})\\s*\\)`));
    const firstRouteAt = starts.length ? starts[0] : Infinity;
    const blanketGuarded = blanketAt >= 0 && blanketAt < firstRouteAt;

    const ungated: string[] = [];
    if (!blanketGuarded) {
      starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : src.length;
        const body = src.slice(start, end);
        const name = body.slice(0, body.indexOf("\n")).trim();
        // The guard may sit on the router line itself (middleware) or in the body.
        if (!guardRe.test(body)) ungated.push(name);
      });
    }
    check(`${file}: every write route names its guard`, ungated.length === 0, ungated);
  }

  /**
   * And the list above has to name every router that needs it.
   *
   * The rule-template routes went unguarded for as long as they did precisely
   * because this suite passed: it checks the files it is told about, so a new
   * router simply is not looked at. Anything with a write route must therefore
   * be either guarded above or listed here as deliberately not org-wide, with
   * the reason.
   */
  const NOT_ORG_WIDE: Record<string, string> = {
    "auth.ts": "session and local AWS setup; guarded by authMiddleware/serverModeGuard, not by team",
    "branches.ts": "acts on one repo with the caller's own token, GitHub authorizes",
    "protection.ts": "same: per-repo, the caller's token",
    "repos.ts": "same: per-repo, the caller's token",
    "webhooks.ts": "not a user route, HMAC-verified GitHub deliveries",
    "graph.ts": "derived cache rebuilt from GitHub; holds no authority of its own",
    "access.ts": "read models over the graph",
    "dependencies.ts": "reads advisories; its two writes enable and disable Dependabot on one repo with the caller's own token",
    "org.ts": "org read-through",
    "me.ts": "everything is the caller's own: it reads no login parameter and writes only their row",
    "meAlarms.ts": "everything is the caller's own: ownership is read from the stored record, "
      + "and the destination is resolved from the session rather than accepted from the body",
  };

  const routeDir = path.join(__dirname, "src/routes");
  const guardedFiles = new Set(GUARDED.map(([f]) => f));
  const unlisted = fs.readdirSync(routeDir)
    .filter((f: string) => f.endsWith(".ts"))
    .filter((f: string) => /router\.(post|put|delete)\(/.test(read(f)))
    .filter((f: string) => !guardedFiles.has(f) && !(f in NOT_ORG_WIDE));

  check("every route file with writes is either guarded or explicitly exempt",
    unlisted.length === 0, unlisted);
}

// ── a gate that decides nothing in the shipped configuration is not a gate ──
//
// The text check above says a guard is *named*. This one runs it.
//
// `permissionGate.ts` opens with `if (process.env.PERMISSIONS_ENABLED !== "true")
// return next();`, and the flag ships unset. So a router guarded exclusively by
// `requirePermission` / `requireAnyPermission` has, in the configuration this
// repository actually deploys, no authorization beyond `authMiddleware` — which
// is how the Admin router shipped with `GET /file` (the whole permissions file),
// `PUT /file` (rewriting it) and `POST /bootstrap` (creating a repository in the
// organization) open to every signed-in member.
//
// Every middleware-gated privileged router is therefore driven here with the
// flag unset and a caller on no team, and must refuse before the handler runs.
{
  const before = process.env.PERMISSIONS_ENABLED;
  delete process.env.PERMISSIONS_ENABLED;   // the shipped state, and never flipped here

  type Decision = { kind: "passed" } | { kind: "refused"; status: number };

  /**
   * Drive a middleware chain against a fake request and report what it decided.
   *
   * "passed" means the chain called `next()` off its end — the handler would
   * have run. A throw counts as passed too: an exception is not a refusal, and
   * an ungated route that happens to fall over on a fake request has still not
   * decided anything about the caller.
   */
  const runChain = (chain: any[], req: any): Promise<Decision> => new Promise(resolve => {
    let done = false;
    const settle = (d: Decision) => { if (!done) { done = true; resolve(d); } };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json() { settle({ kind: "refused", status: this.statusCode }); return this; },
      send() { return this.json(); },
      end() { return this.json(); },
    };
    let i = 0;
    const next = () => {
      if (done) return;
      if (i >= chain.length) return settle({ kind: "passed" });
      const mw = chain[i++];
      try {
        const out = mw(req, res, next);
        if (out && typeof out.catch === "function") out.catch(() => settle({ kind: "passed" }));
      } catch { settle({ kind: "passed" }); }
    };
    next();
    setTimeout(() => settle({ kind: "passed" }), 5000).unref?.();
  });

  const caller = () => ({ user: { login: "on-no-team", accessToken: "a-token" }, params: {}, query: {}, body: {} });

  /**
   * The premise, asserted rather than assumed.
   *
   * This used to read "requirePermission decides nothing while
   * PERMISSIONS_ENABLED is unset" — the flag short-circuited the gate before
   * it asked anything, which is why a team gate had to stand in front of the
   * admin router. The switch is the file now, and no credentials are loaded
   * here, so the file cannot be read and the gate refuses as an outage.
   *
   * That is the behaviour to pin: **a gate that cannot establish standing
   * refuses.** Passing here would mean an unreadable file reopened every route
   * it guards, which is the failure this whole design is arranged against.
   */
  {
    const { requirePermission: perm } = await import("./src/middleware/permissionGate");
    const d = await runChain([perm("admin.people.assign")], caller());
    check("a gate that cannot read the file refuses rather than continuing",
      d.kind === "refused" && d.status === 503, d);
  }

  /**
   * The routers whose gating is middleware, so a chain can be driven through
   * it. `widgets.ts`, `alerts.ts`, `config.ts`, `activity.ts`
   * and `pulls.ts` decide inside their handlers instead — which the text check
   * above covers and this cannot, since reaching the handler is the point there
   * rather than the bug.
   */
  for (const file of ["admin", "access", "alarms", "awsGuardrails"]) {
    const router: any = (await import(`./src/routes/${file}`)).default;
    const blanket = router.stack.filter((l: any) => !l.route).map((l: any) => l.handle);

    const open: string[] = [];
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const handlers = layer.route.stack.map((s: any) => s.handle);
      // Everything but the handler itself: the guards, in the order express
      // would run them, with the router-level `use` gates in front.
      const decision = await runChain([...blanket, ...handlers.slice(0, -1)], caller());
      if (decision.kind === "passed") {
        open.push(`${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
      }
    }

    check(`${file}.ts: every route still refuses somebody on no team with the flag unset`,
      open.length === 0, open);
  }

  if (before === undefined) delete process.env.PERMISSIONS_ENABLED;
  else process.env.PERMISSIONS_ENABLED = before;
}

// ── the gate must cover everything the route acts on ──────────────────
// Retry shipped checking only the top-level entry while executing across the
// whole tree, so a template retry spanning five repos verified one. The route
// text is checked for the shape that prevents it: gather descendants, then
// gate, then execute.
{
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "src/routes/activity.ts"), "utf8");

  const routeBody = (name: string) => {
    const i = src.indexOf(`router.post("/:id/${name}"`);
    const next = src.indexOf('router.post("/:id/', i + 10);
    return src.slice(i, next === -1 ? src.length : next);
  };

  for (const name of ["undo", "redo", "retry"]) {
    const body = routeBody(name);
    const gate = body.indexOf("denyIfNotPermitted");
    const gather = body.indexOf("getChildActivities");
    const exec = Math.min(
      ...["executeUndo(", "executeRedo(", "executeRetry("]
        .map(f => body.indexOf(f)).filter(i => i !== -1).concat([Number.MAX_SAFE_INTEGER]));

    check(`${name}: descendants are gathered before the gate runs`,
      gather !== -1 && gate !== -1 && gather < gate, { gather, gate });
    check(`${name}: nothing executes before the gate`,
      gate !== -1 && exec !== Number.MAX_SAFE_INTEGER && gate < exec, { gate, exec });
    check(`${name}: the gate is handed more than the single entry`,
      /denyIfNotPermitted\(\s*(?!\[entry\],)/.test(body),
      body.slice(gate, gate + 90));
  }
}

/**
 * Undoing an AWS change is the AWS team's business, not the Control Hub team's.
 *
 * Asked for as "if they are not on the aws guardrails team, they definitely
 * should NOT be able to undo any aws events from the activity tab". They
 * cannot, and not because anything checks: no AWS row carries an `undoPayload`
 * — every logActivity call in awsGuardrails.ts passes five arguments and the
 * payload is the tenth — so `isReversible` is false and the route refuses
 * before any permission is consulted. Safe, and reached by accident.
 *
 * One line from becoming a hole. `undoRequirement` used to hand every
 * unrecognized action `{ repo: "admin", adminTeam: true }`, which demands the
 * *Control Hub* team — so making a single AWS action undoable would have let a
 * Control Hub admin who was deliberately kept off the AWS team reverse a
 * guardrail change. These pin the distinction while it is still cheap.
 */
console.log("\nan AWS row is the AWS team's to reverse");
{
  const policy = fs.readFileSync(`${__dirname}/src/services/undoPolicy.ts`, "utf8");
  const activity = fs.readFileSync(`${__dirname}/src/routes/activity.ts`, "utf8");

  check("the requirement can name the AWS team at all",
    /awsTeam\?: boolean;/.test(policy),
    "with only `adminTeam` there is nowhere correct to put this");

  check("  and an unlisted AWS action falls back to it, not to the Control Hub team",
    /isAwsAction\(entry\.action\)\s*\n?\s*\? \{ awsTeam: true \}/.test(policy),
    "the fallback is what an action nobody listed gets, which is the dangerous case");

  check("  while an unlisted repository action still demands the most",
    /\{ repo: "admin", adminTeam: true \}/.test(policy));

  check("the undo route enforces it",
    /awsTeam && !\(await teamOrPermission\(login, accessToken, "aws"/.test(activity)
    && /AWS_ADMIN_REQUIRED/.test(activity));

  // Separate authorities. Passing the Control Hub check must not admit
  // somebody to an AWS change, so the AWS check cannot sit behind it.
  const deny = activity.slice(activity.indexOf("async function denyIfNotPermitted"));
  const body = deny.slice(0, deny.indexOf("\n}\n"));
  check("  and checks it independently of the Control Hub team",
    body.indexOf("if (awsTeam &&") >= 0 && body.indexOf("if (awsTeam &&") < body.indexOf("if (adminTeam &&"),
    "one gate behind the other makes them one authority");

  // The state that makes all of the above theoretical, asserted so that the
  // day it changes, the assertions above are already standing.
  const allowList = policy.slice(
    policy.indexOf("ALLOWED_UNDO_ACTIONS"), policy.indexOf("]);"));
  check("and no AWS row is undoable today, which is why none of this fires",
    !/aws\./.test(allowList),
    "an AWS action in the allow-list would make this live rather than latent");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
})();
