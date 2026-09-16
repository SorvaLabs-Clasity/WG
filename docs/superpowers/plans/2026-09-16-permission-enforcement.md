# Permission Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a permission gate in front of every route, behind a flag that stays off until stage 4's dry-run says who would lose what — and make it impossible for a new route to ship ungated.

**Architecture:** One `requirePermission(key)` middleware reading stage 2's `accessFor`. A build-time assertion that every route names a permission and every permission is named by a route. A `/me/permissions` endpoint so the client renders what the server would allow. Nothing enforces until `PERMISSIONS_ENABLED=true`.

**Tech Stack:** TypeScript, Express, React. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-admin-console-permissions-design.md`
**Builds on:** stages 1 and 2, both merged.

## Global Constraints

- **No new npm dependencies.**
- **Nothing enforces by default.** With `PERMISSIONS_ENABLED` unset or not `"true"`, every gate calls `next()` and the existing team gates continue to decide. Flipping the flag is stage 4's job, after the dry-run.
- **Every per-request call to `accessFor` passes the caller's own token** — `accessFor(req.user.login, req.user.accessToken)`. Omitting it silently falls into stage 2's O(teams) admin path. This is a hard contract carried over from stage 2's review.
- **A gate never replaces GitHub's authority.** Repo actions still go out with the caller's token; a permission is necessary, never sufficient. Do not add gates to `branches.ts`, `protection.ts`, `repos.ts` or `dependencies.ts`'s per-repo writes beyond what the mapping table says.
- Tests follow the repo idiom: `repro-*.ts`, `npx tsx`, local `check(name, ok, got?)`. No test framework.
- Backend commands run from `github-control-hub/backend/`, frontend from `github-control-hub/frontend/`.
- Every task ends green: backend `npx tsc --noEmit -p tsconfig.json`, frontend `npx tsc -b --force`, and the full backend sweep at `failing=0`.

## File Structure

| File | Responsibility |
|---|---|
| `src/permissions/testing.ts` | A seam that lets tests drive the engine without GitHub. |
| `src/middleware/permissionGate.ts` | `requirePermission`, and the flag. |
| `src/routes/*.ts` | Each write and read route names its permission. |
| `repro-permissiongates.ts` | The completeness assertions. |
| `frontend/src/hooks/usePermissions.ts` | What the client is allowed to render. |
| `frontend/src/components/NoAccess.tsx` | What somebody with nothing sees. |

---

### Task 1: A seam, and behavioural tests for the team-attribution fix

Stage 2's whole-branch review found a Critical — `subjectFor` attributed the token holder's teams to whatever login it was handed — and the fix is currently guarded only by source-text greps that would pass if the token argument were swapped back. This task closes that, and gives every later task a way to test the engine without GitHub.

**Files:**
- Create: `src/permissions/testing.ts`
- Modify: `src/permissions/subject.ts`, `src/permissions/store.ts`
- Modify: `repro-permissionsfile.ts`

**Interfaces:**
- Produces: `setPermissionsTestHooks(hooks: TestHooks | null): void`, `TestHooks { loadFile?: () => LoadedPermissions | LoadFailure; ownTeams?: (token: string) => string[]; teamsOf?: (login: string) => string[]; ownerOf?: (login: string) => boolean }`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissionsfile.ts`, before the final two lines:

```ts
console.log("\nteams belong to the person they were read for");
{
  /**
   * The Critical stage 2's review found, tested by behaviour rather than by
   * grepping the source. `teams.listForAuthenticatedUser` takes no username, so
   * an implementation that passes the wrong token attributes one person's teams
   * to another — and the old tests would have passed through that bug.
   */
  setPermissionsTestHooks({
    loadFile: () => ({ file: { version: 1, presets: {},
      teams: { admins: { grant: ["aws"] } }, people: {} }, sha: "x", source: "github" }),
    ownTeams: (token: string) => token === "admin-token" ? ["admins"] : [],
    teamsOf: (login: string) => login === "an-admin" ? ["admins"] : [],
    ownerOf: () => false,
  });

  const self = await accessFor("an-admin", "admin-token");
  check("your own token gives you your own teams", self.permissions.has("aws.rules.read"));

  // The bug: inspecting somebody else with your token must not give them yours.
  const other = await accessFor("somebody-else", "admin-token");
  check("inspecting somebody else does not lend them your teams",
    !other.permissions.has("aws.rules.read"),
    "an admin's teams were being attributed to whoever they inspected");

  // And the misattribution must not be cached against them either.
  const otherAgain = await accessFor("somebody-else");
  check("  nor is it cached against them",
    !otherAgain.permissions.has("aws.rules.read"));

  setPermissionsTestHooks(null);
  forgetPermissions();
  forgetSubjects();
}
```

Extend the imports at the top of `repro-permissionsfile.ts`:

```ts
import { accessFor } from "./src/permissions/index";
import { forgetSubjects } from "./src/permissions/subject";
import { setPermissionsTestHooks } from "./src/permissions/testing";
```

The suite's top-level code is not currently inside an async function. Wrap the whole body in `(async () => { ... })();` if it is not already, so `await` is available — follow whatever shape `repro-permissions.ts` uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `Cannot find module './src/permissions/testing'`

- [ ] **Step 3: Write the seam**

Create `src/permissions/testing.ts`:

```ts
import type { LoadedPermissions, LoadFailure } from "./store";

/**
 * A seam for tests, and only for tests.
 *
 * The engine is pure and already tested directly. What was not testable was the
 * *composition* — that `accessFor` reads the right person's teams with the right
 * token — because everything below it talks to GitHub. Stage 2 shipped a
 * Critical in exactly that composition (one person's teams attributed to
 * another), and its fix was guarded only by greps over the source text, which
 * would have passed had the token argument been swapped back.
 *
 * Deliberately a set of *functions* rather than a mocked Octokit: the thing
 * worth pinning is which login and which token each answer was derived from,
 * and a hook that takes those as arguments states that directly.
 *
 * Null in production. Nothing reads these unless a test has installed them.
 */
export interface TestHooks {
  loadFile?: () => LoadedPermissions | LoadFailure;
  /** Teams for the holder of this token. */
  ownTeams?: (token: string) => string[];
  /** Teams for a named login, read with the App token. */
  teamsOf?: (login: string) => string[];
  ownerOf?: (login: string) => boolean;
}

let hooks: TestHooks | null = null;

export function setPermissionsTestHooks(next: TestHooks | null): void {
  hooks = next;
}

export function testHooks(): TestHooks | null {
  return hooks;
}
```

- [ ] **Step 4: Wire the seam in**

In `src/permissions/store.ts`, at the top of the function that performs the read (the one `loadPermissions` calls when the cache misses), return the hook's answer when one is installed:

```ts
const hooked = testHooks()?.loadFile;
if (hooked) return hooked();
```

In `src/permissions/subject.ts`, inside `subjectFor`, consult the hooks before any GitHub call:
- ownership: if `testHooks()?.ownerOf` exists, use it instead of the API call;
- own-token teams: if `testHooks()?.ownTeams` exists, call it with the `ownToken`;
- another login's teams: if `testHooks()?.teamsOf` exists, call it with the login.

Import `testHooks` from `./testing` in both files. Keep every existing code path intact for when no hooks are installed.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 6: Prove the test would catch the bug**

Temporarily change `subject.ts` so the own-token path is used for any login regardless of `ownToken` (reintroducing the Critical), re-run, and confirm the new checks FAIL. Then revert the change and confirm they pass again. Record both outputs in your report — a test that cannot fail is not a test.

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/permissions/testing.ts src/permissions/subject.ts src/permissions/store.ts repro-permissionsfile.ts
git commit -m "Test the composition, not the source text"
```

---

### Task 2: The gate

**Files:**
- Create: `src/middleware/permissionGate.ts`
- Test: `repro-permissiongates.ts`

**Interfaces:**
- Produces: `PERMISSIONS_ENABLED: () => boolean`, `requirePermission(key: string): RequestHandler`, `requireAnyPermission(...keys: string[]): RequestHandler`, `PERMISSION_DENIED = "PERMISSION_REQUIRED"`.

- [ ] **Step 1: Write the failing test**

Create `repro-permissiongates.ts`:

```ts
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
   */
  check("every gate passes the caller's own token",
    /accessFor\(\s*req\.user!?\.login,\s*req\.user!?\.accessToken/.test(gate),
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

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissiongates.ts`
Expected: FAIL — `ENOENT ... src/middleware/permissionGate.ts`

- [ ] **Step 3: Write the gate**

Create `src/middleware/permissionGate.ts`:

```ts
import type { RequestHandler } from "express";
import { accessFor } from "../permissions";

/**
 * One permission, in front of one route.
 *
 * Shaped like the `requireControlHubAdmin` it will eventually replace, so that
 * reading a route file still tells you what it costs to call — the guard is
 * named on the route, not looked up in a table somewhere else. That is the
 * whole reason for choosing this over a central policy map: a route added with
 * no guard is a build failure rather than a lookup miss.
 *
 * **Off by default.** With `PERMISSIONS_ENABLED` unset, every gate calls
 * `next()` and the existing team gates continue to decide. The flag is flipped
 * in stage 4, once the dry-run has said exactly who would lose what — deny by
 * default means switching this on is a cliff, and the cliff is somebody's
 * decision rather than a deploy's side effect.
 */

export const PERMISSION_DENIED = "PERMISSION_REQUIRED";

export const PERMISSIONS_ENABLED = (): boolean =>
  process.env.PERMISSIONS_ENABLED === "true";

function gate(keys: string[], needsAll: boolean): RequestHandler {
  return (req, res, next) => {
    if (!PERMISSIONS_ENABLED()) return next();

    // Always the caller's own token. Omitting it drops stage 2's subject
    // builder into the path that lists every team in the organization, which is
    // one GitHub call per team on every request.
    accessFor(req.user!.login, req.user!.accessToken)
      .then(access => {
        // No organization, no file, nothing to decide.
        if (access.inert) return next();

        /**
         * Could not ask, as opposed to "you may not". Answering 403 here would
         * tell somebody they had lost access they still have, and send them to
         * request something they already hold.
         */
        if (access.failure) {
          return res.status(503).json({
            code: "PERMISSIONS_UNAVAILABLE",
            error: `Permissions could not be read, so this cannot be allowed or refused. ${access.failure.detail}`,
          });
        }

        const held = needsAll
          ? keys.every(k => access.permissions.has(k))
          : keys.some(k => access.permissions.has(k));
        if (held) return next();

        res.status(403).json({
          code: PERMISSION_DENIED,
          permission: keys.join(" or "),
          error: `This needs the "${keys.join('" or "')}" permission, which you do not have.`,
        });
      })
      .catch(err => {
        // A throw is not a decision. Closed, and said as an outage.
        res.status(503).json({
          code: "PERMISSIONS_UNAVAILABLE",
          error: `Permissions could not be read: ${err?.message ?? err}`,
        });
      });
  };
}

/** The route needs this permission. */
export function requirePermission(key: string): RequestHandler {
  return gate([key], true);
}

/** The route needs at least one of these — for a screen reachable two ways. */
export function requireAnyPermission(...keys: string[]): RequestHandler {
  return gate(keys, false);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissiongates.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add src/middleware/permissionGate.ts repro-permissiongates.ts
git commit -m "A permission gate that does nothing until it is switched on"
```

---

### Task 3: Name a permission on every route

This is mechanical and large. Work through the route files in the order below, committing after each group so a mistake is easy to isolate.

**Files:** every file in `src/routes/` except `auth.ts` and `webhooks.ts`.

**The mapping.** Each route file maps to a branch of the vocabulary. Read `src/permissions/vocabulary.ts` for the exact leaf names — do not guess them; the completeness assertion in Task 4 fails on any key that is not in the vocabulary.

| Route file | Branch | Notes |
|---|---|---|
| `activity.ts` | `activity.*` | `GET /` needs `activity.read.own`; undo/redo/retry map to `activity.undo.*`, `activity.retry`, `activity.resolution.undo`; detailed-logging to `activity.detailedLogging.*` |
| `alarms.ts` | `alarms.*` | keep `refusedForSubject` — a guardrail alarm additionally needs `aws.rules.edit` |
| `awsGuardrails.ts` | `aws.*` | the router-level `requireAwsAdmin` stays until the flag flips |
| `access.ts` | `access.*` | the router-level `requireControlHubAdmin` stays too |
| `scanners.ts` | `scanners.*` | |
| `widgets.ts` | `widgets.org.*` and `me.widgets.*` | a personal widget is the caller's own; the shared board is org |
| `graph.ts` | `repos.*` | the Repos tab is `/graph` |
| `pulls.ts` | `pulls.*` | |
| `dependencies.ts` | `deps.*` | its two per-repo writes stay authorized by GitHub as well |
| `expertise.ts` | `expertise.*` | |
| `org.ts` | `org.*` | |
| `githubBudget.ts` | `org.budget.read` | |
| `config.ts` | `config.export` / `config.import` | |
| `me.ts`, `meAlarms.ts` | `me.*` | all of it is the caller's own |
| `alerts.ts` | `activity.read.app.rows` | it reads the important-events feed |

**Add the gate as middleware on the route line**, beside the existing guards, never replacing them:

```ts
router.post("/", requirePermission("alarms.org.create"), async (req, res) => { … })
```

For a router-wide read gate where every route in the file needs the same thing, `router.use(requirePermission("access.read"))` is acceptable **only if it precedes the first route** — a gate halfway down leaves everything above it open.

- [ ] **Step 1: Wire `activity.ts`, `alarms.ts`, `alerts.ts`. Run the backend sweep. Commit.**
- [ ] **Step 2: Wire `awsGuardrails.ts`, `access.ts`, `scanners.ts`, `widgets.ts`. Run the sweep. Commit.**
- [ ] **Step 3: Wire `graph.ts`, `pulls.ts`, `dependencies.ts`, `expertise.ts`. Run the sweep. Commit.**
- [ ] **Step 4: Wire `org.ts`, `githubBudget.ts`, `config.ts`, `me.ts`, `meAlarms.ts`. Run the sweep. Commit.**

After each group: `npx tsc --noEmit -p tsconfig.json` clean, and the full sweep at `failing=0`. The flag is off, so behaviour must not change at all — any suite that starts failing means a gate was added where it changes something, which it must not yet.

---

### Task 4: Make an ungated route a build failure

**Files:**
- Modify: `repro-permissiongates.ts`

- [ ] **Step 1: Write the assertions**

Append to `repro-permissiongates.ts`, before the final two lines:

```ts
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
      if (!/require(Any)?Permission\(/.test(body)) {
        ungated.push(`${file}: ${body.slice(0, body.indexOf("\n")).trim()}`);
      }
    });
  }

  check("every route names a permission", ungated.length === 0, ungated.slice(0, 8));

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
```

- [ ] **Step 2: Run it**

Run: `npx tsx repro-permissiongates.ts`

It will likely fail on `unused` — permissions with no route yet. For each, either wire the route it belongs to, or, if it genuinely has no endpoint (a purely client-side concern), remove it from the vocabulary and say so in your report. **Do not** silence the assertion. Report which you did for each key.

- [ ] **Step 3: Typecheck and commit**

```bash
npx tsc --noEmit -p tsconfig.json
git add repro-permissiongates.ts src/routes src/permissions
git commit -m "An ungated route, or an invented permission, is a build failure"
```

---

### Task 5: What the client is allowed to render

**Files:**
- Modify: `src/routes/me.ts` (add `GET /me/permissions`)
- Modify: `frontend/src/api/me.ts`
- Create: `frontend/src/hooks/usePermissionSet.ts`
- Create: `frontend/src/components/NoAccess.tsx`
- Modify: `frontend/src/components/Navbar.tsx`

- [ ] **Step 1: Add the endpoint**

In `src/routes/me.ts`, add — it must NOT be gated on a permission, since it is how the client learns which permissions it has:

```ts
/**
 * What this person may do, for the client to render against.
 *
 * Deliberately ungated. Gating the list of your own permissions on a permission
 * is a circle, and the answer reveals nothing about anybody else.
 */
router.get("/permissions", async (req: Request, res: Response) => {
  const { accessFor } = await import("../permissions");
  const { PERMISSIONS_ENABLED } = await import("../middleware/permissionGate");
  try {
    const access = await accessFor(req.user!.login, req.user!.accessToken);
    res.json({
      enforced: PERMISSIONS_ENABLED(),
      inert: access.inert,
      held: access.permissions.held,
      failure: access.failure ? { reason: access.failure.reason, detail: access.failure.detail } : null,
      adminTeam: process.env.CONTROL_HUB_ADMIN_TEAM || "control-hub-admins",
    });
  } catch (err: any) {
    res.status(503).json({ error: `Permissions could not be read: ${err?.message ?? err}` });
  }
});
```

Add a matching `repro-permissiongates.ts` assertion that this route exists and carries no `requirePermission`.

- [ ] **Step 2: The client hook**

Create `frontend/src/hooks/usePermissionSet.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";

export interface MyPermissions {
  enforced: boolean;
  inert: boolean;
  held: string[];
  failure: { reason: string; detail: string } | null;
  adminTeam: string;
}

/**
 * What this person may do, as the server sees it.
 *
 * The client renders against this; it never decides anything. Every answer here
 * is also enforced server-side, so a stale or wrong value costs a confusing
 * screen rather than an unauthorized action.
 *
 * `enforced: false` means the flag is off and the old team gates are still
 * deciding — in that state the client must behave exactly as it did before,
 * which is why `can()` answers true for everything until it flips.
 */
export function usePermissionSet() {
  const query = useQuery({
    queryKey: ["me", "permissions"],
    queryFn: () => apiGet<MyPermissions>("/me/permissions"),
    staleTime: 60_000,
  });

  const data = query.data;
  const held = new Set(data?.held ?? []);

  /** Whether a permission is held. True for everything until the flag is on. */
  const can = (key: string): boolean => {
    if (!data) return true;             // still loading: do not flash an empty app
    if (!data.enforced || data.inert) return true;
    if (data.failure) return false;     // could not ask: show nothing rather than a lie
    return held.has(key);
  };

  return { ...query, can, permissions: data };
}
```

- [ ] **Step 3: The no-access screen**

Create `frontend/src/components/NoAccess.tsx`. Under deny-by-default this is the entire app for a new hire, so it must name the organization, say permissions have not been granted yet, and name the team to ask. Follow the visual idiom of `RequireTeam.tsx`'s `Locked` component — read it first — and render inside `<Page>` so the navigation is present, which is the bug `RequireTeam` had.

- [ ] **Step 4: Filter the section line**

In `frontend/src/components/Navbar.tsx`, give each entry in `ITEMS` a `permission` field naming the read key for that tab (`me.work.read`, `overview.read`, `aws.read`, `alarms.org.read`, `access.read`, `deps.read`, `repos.read`, `pulls.read`, `expertise.read`, `activity.read.own`). Filter `items` by `can(item.permission)`, alongside the existing `githubBlocked` filter.

Add an assertion in `repro-permissiongates.ts` that every `ITEMS` permission exists in the vocabulary.

- [ ] **Step 5: Verify and commit**

Backend: `npx tsc --noEmit -p tsconfig.json`, full sweep `failing=0`.
Frontend: `npx tsc -b --force`, `npx vite build`, frontend sweep `failing=0`.

```bash
git add -A
git commit -m "Render against the permissions the server would enforce"
```

---

## What this stage deliberately does not do

- **It does not switch enforcement on.** `PERMISSIONS_ENABLED` stays unset. Every gate calls `next()`, every team gate still decides, and behaviour is unchanged.
- **It does not remove the team gates.** They come out in stage 4, after the flip.
- **No admin UI, no migration, no dry-run.** Stage 4.

## Next plan

- **Stage 4 — the Admin tab:** the four screens, the migration generator that writes a starting file from today's team membership, the dry-run diff ("these N people would lose these things"), then the flip and the removal of `aws-guardrail-admins`.
