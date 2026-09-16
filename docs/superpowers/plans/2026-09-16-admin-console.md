# Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Admin tab — see who holds what, assign presets, toggle individual permissions, read the audit trail — plus the migration that makes switching enforcement on safe rather than a cliff.

**Architecture:** A new `/api/admin` router gated on `admin.*`, reading and writing stage 2's store. A migration generator that writes a starting file from today's team membership, and a dry-run that says who would lose what before anybody flips the flag. A React tab with four screens, the main one a tri-state tree over the 109-leaf vocabulary.

**Tech Stack:** TypeScript, Express, React 19, Tailwind. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-admin-console-permissions-design.md`
**Builds on:** stages 1, 2 and 3, all merged.

## Global Constraints

- **No new npm dependencies.**
- **Do not flip `PERMISSIONS_ENABLED` anywhere in code or config.** This plan builds the tools that make flipping it safe; the flip itself is a deployment decision the operator takes afterwards.
- **Deny by default is already live in the engine.** Do not add any implicit grant. The migration writes an explicit file instead.
- **Every per-request permission read uses `accessForSelf(login, token)`.** Inspecting *another* login uses `accessForOther(login)`, which takes no token — that separation exists because passing a token for somebody else silently lent them your teams.
- Tests follow the repo idiom: `repro-*.ts`, `npx tsx`, local `check()`. No test framework.
- Backend from `github-control-hub/backend/`, frontend from `github-control-hub/frontend/`.
- Every task ends green: backend `tsc --noEmit` + sweep `failing=0`; frontend `tsc -b --force` + `vite build` + sweep `failing=0`.

## File Structure

| File | Responsibility |
|---|---|
| `src/routes/admin.ts` | The `/api/admin` router: read, save, audit, bootstrap. |
| `src/permissions/migrate.ts` | The starting file, and the dry-run diff. Pure. |
| `frontend/src/pages/AdminPage.tsx` | The tab, and its four screens. |
| `frontend/src/components/PermissionTree.tsx` | The tri-state tree over the vocabulary. |
| `frontend/src/api/admin.ts` | The client. |
| `repro-admin.ts` | Route gating, migration and dry-run assertions. |

---

### Task 1: The admin router

**Files:**
- Create: `src/routes/admin.ts`
- Modify: `src/server.ts` (mount it)
- Create: `repro-admin.ts`

**Interfaces:**
- Produces these endpoints, every one gated:

| Method | Path | Permission |
|---|---|---|
| GET | `/api/admin/file` | `admin.people.read` |
| PUT | `/api/admin/file` | `admin.people.assign` |
| GET | `/api/admin/vocabulary` | `admin.console.open` |
| GET | `/api/admin/person/:login` | `admin.people.read` |
| GET | `/api/admin/audit` | `admin.audit.read` |
| POST | `/api/admin/bootstrap` | `admin.people.assign` |

- [ ] **Step 1: Write the failing test**

Create `repro-admin.ts`:

```ts
/**
 * The Admin tab's routes.
 *
 * This is the one router that can grant permissions, so it is the one whose own
 * gating matters most: a hole here is a hole in everything. It is also the
 * router most likely to be reached by somebody who holds nothing, since the
 * screen exists precisely to give people access.
 *
 * Run:  npx tsx repro-admin.ts   from github-control-hub/backend
 */
import fs from "node:fs";
import { PERMISSIONS } from "./src/permissions/vocabulary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const admin = fs.readFileSync("./src/routes/admin.ts", "utf8");
const server = fs.readFileSync("./src/server.ts", "utf8");

console.log("the admin router");
{
  check("it is mounted", /\/api\/admin/.test(server) && /adminRoutes/.test(server));

  check("  behind authentication", /app\.use\("\/api\/admin",\s*authMiddleware/.test(server));

  /**
   * Reading the file means reading who holds what across the organization —
   * the same aggregation the access map is gated on. Writing it is the most
   * privileged act in the app.
   */
  for (const [path, permission] of [
    ['router.get("/file"', "admin.people.read"],
    ['router.put("/file"', "admin.people.assign"],
    ['router.get("/vocabulary"', "admin.console.open"],
    ['router.get("/person/:login"', "admin.people.read"],
    ['router.get("/audit"', "admin.audit.read"],
    ['router.post("/bootstrap"', "admin.people.assign"],
  ] as const) {
    const at = admin.indexOf(path);
    const line = at >= 0 ? admin.slice(at, admin.indexOf("\n", at)) : "";
    check(`  ${path.slice(12)} needs ${permission}`,
      at >= 0 && line.includes(`requirePermission("${permission}")`), line.trim());
  }

  /**
   * Inspecting somebody else must not lend them the inspector's teams. Stage 2
   * shipped exactly that bug; the two-function split is what prevents it, and
   * this router is the caller that would reintroduce it.
   */
  check("inspecting another login uses the tokenless call",
    /accessForOther\(/.test(admin) && !/accessForSelf\([^)]*params/.test(admin),
    "accessForSelf with somebody else's login lends them your teams");

  // A save that does not carry the sha it read silently discards a concurrent edit.
  check("saving sends the sha the editor loaded",
    /savePermissions\(/.test(admin) && /sha/.test(admin));

  check("  and a conflict is reported as one, not as a failure",
    /conflict/.test(admin) && /409/.test(admin));

  // The file is validated by savePermissions, but the route should say which
  // entry is wrong rather than passing a bare rejection to the screen.
  check("an invalid file is refused with its problems named",
    /problems/.test(admin));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-admin.ts`
Expected: FAIL — `ENOENT ... src/routes/admin.ts`

- [ ] **Step 3: Write the router**

Create `src/routes/admin.ts`. Read `src/routes/access.ts` first for the shape a router takes here. It must:

- Import `requirePermission` from `../middleware/permissionGate`.
- `GET /file` — `loadPermissions()`, and return `{ file, sha, source, unknownNodes, problems }`. On a `LoadFailure`, return 200 with `{ failure }` rather than an error: the Admin tab's whole job is to fix a broken file, so it must be able to see one. Say that in a comment.
- `PUT /file` — body `{ file, sha }`. Call `savePermissions(file, sha, req.user!.login, summary)` where `summary` is a short line derived from the change (the client sends one; validate it is a non-empty string under 200 chars). Map `reason: "conflict"` to **409**, `"invalid"` to **400** with the problems listed, `"failed"` to **502**.
- `GET /vocabulary` — `{ permissions: PERMISSIONS, version: VOCABULARY_VERSION }`, so the tree renders from the server's list rather than a copy that can drift.
- `GET /person/:login` — `accessForOther(login)`, returning `{ login, held, explanations }` where `explanations` maps each held-or-denied leaf to `permissions.explain(leaf)`. **Use `accessForOther`, never `accessForSelf`.**
- `GET /audit` — `repos.listCommits` on the permissions repo, path-filtered to the file, mapped to `{ sha, message, author, date }`. Use the App token via `createOctokit(token, "Permissions")` so the budget note already covers it.
- `POST /bootstrap` — body `{ createRepo?: boolean }`. When the repo is missing and `createRepo` is true, create it **private**; then, if the file is missing, write an empty one via `savePermissions(emptyFile(), null, actor, "Initialise permissions")`. Return what it did.

Every route gated per the table above.

- [ ] **Step 4: Mount it**

In `src/server.ts`, beside the other mounts:

```ts
app.use("/api/admin", authMiddleware, githubGateMiddleware, adminRoutes);
```

- [ ] **Step 5: Verify and commit**

`npx tsx repro-admin.ts` → ALL PASS. `npx tsc --noEmit -p tsconfig.json` clean. Backend sweep `failing=0` — note `repro-permissiongates.ts` will now check this router too, so its routes must all be gated.

```bash
git add src/routes/admin.ts src/server.ts repro-admin.ts
git commit -m "The one router that can grant permissions, gated hardest"
```

---

### Task 2: The migration, and the dry-run

**Files:**
- Create: `src/permissions/migrate.ts`
- Modify: `src/routes/admin.ts` (two endpoints), `repro-admin.ts`

**Interfaces:**
- Produces: `startingFile(members: MemberSnapshot[]): PermissionsFile`, `MemberSnapshot { login: string; isControlHubAdmin: boolean; isAwsAdmin: boolean; isOrgOwner: boolean }`, `DryRunRow { login: string; losing: string[]; keeping: number; isOrgOwner: boolean }`, `dryRun(file: PermissionsFile, members: MemberSnapshot[]): DryRunRow[]`.
- Two endpoints: `GET /api/admin/dry-run` (`admin.people.read`), `POST /api/admin/migrate` (`admin.people.assign`).

- [ ] **Step 1: Write the failing test**

Append to `repro-admin.ts`, before the final two lines:

```ts
console.log("\nthe starting file");
{
  const members = [
    { login: "an-admin", isControlHubAdmin: true, isAwsAdmin: false, isOrgOwner: false },
    { login: "aws-person", isControlHubAdmin: false, isAwsAdmin: true, isOrgOwner: false },
    { login: "an-owner", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: true },
    { login: "everybody-else", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: false },
  ];
  const file = startingFile(members);

  /**
   * Deny by default means switching enforcement on is a cliff: everybody loses
   * everything until the file names them. The starting file exists so that the
   * flip changes nothing on day one — it reproduces today's behaviour, and the
   * narrowing happens afterwards, deliberately, one person at a time.
   */
  check("every member is named", Object.keys(file.people).length === members.length,
    Object.keys(file.people));

  check("there are presets rather than per-person permission lists",
    Object.keys(file.presets).length >= 3, Object.keys(file.presets));

  check("  and every person holds one",
    Object.values(file.people).every(p => (p.presets ?? []).length > 0));

  check("the file it produces is valid", fileProblems(file).length === 0, fileProblems(file));

  // Today's two teams become two presets; everybody else gets the one that
  // reproduces what a plain member can do now.
  const admin = permissionsFor(file, { login: "an-admin", teamSlugs: [], isOrgOwner: false });
  const member = permissionsFor(file, { login: "everybody-else", teamSlugs: [], isOrgOwner: false });
  const aws = permissionsFor(file, { login: "aws-person", teamSlugs: [], isOrgOwner: false });

  check("a Control Hub admin keeps the admin screens", admin.has("access.read"));
  check("  and the AWS person keeps the AWS ones", aws.has("aws.rules.edit"));
  check("  while a plain member does not", !member.has("access.read") && !member.has("aws.rules.edit"));

  /**
   * The part that decides whether the flip is survivable. Reading is a
   * permission now, so a plain member who could open Activity and My work
   * yesterday must still be able to today.
   */
  check("a plain member keeps their own screens",
    member.has("me.work.read") && member.has("me.alarms.manage") && member.has("me.alerts.manage"));
  check("  and the reads that were open to everybody",
    member.has("activity.read.own") && member.has("repos.read") && member.has("pulls.read"));
  check("  but not the ability to change org-wide settings",
    !member.has("alarms.org.create") && !member.has("scanners.manage"));

  // Owners are exempt in the engine; naming them anyway keeps the file a
  // complete picture of the organization rather than a list with holes.
  check("an owner is named too", !!file.people["an-owner"]);
}

console.log("\nthe dry run");
{
  const members = [
    { login: "an-admin", isControlHubAdmin: true, isAwsAdmin: false, isOrgOwner: false },
    { login: "everybody-else", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: false },
  ];

  // An empty file is what the flip would use if nobody ran the migration.
  const rows = dryRun(emptyFile(), members);
  check("with an empty file, everybody loses everything",
    rows.length === 2 && rows.every(r => r.losing.length > 0 && r.keeping === 0), rows);

  // With the starting file, nobody loses anything — that is the whole point.
  const safe = dryRun(startingFile(members), members);
  check("with the starting file, nobody loses anything",
    safe.every(r => r.losing.length === 0), safe.filter(r => r.losing.length));

  check("  and everybody keeps something", safe.every(r => r.keeping > 0));

  check("an owner is reported as exempt rather than as losing nothing by luck",
    dryRun(emptyFile(), [{ login: "o", isControlHubAdmin: false, isAwsAdmin: false, isOrgOwner: true }])[0]
      .isOrgOwner === true);
}
```

Extend the imports at the top of `repro-admin.ts`:

```ts
import { startingFile, dryRun } from "./src/permissions/migrate";
import { fileProblems } from "./src/permissions/validate";
import { permissionsFor } from "./src/permissions/evaluate";
import { emptyFile } from "./src/permissions/types";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-admin.ts`
Expected: FAIL — `Cannot find module './src/permissions/migrate'`

- [ ] **Step 3: Write the migration**

Create `src/permissions/migrate.ts`. Pure — no GitHub, no `process.env`. It must build a file with at least three presets:

- **`member`** — what a plain signed-in person can do today: every `me.*` leaf, plus the reads that are currently open to everybody (`activity.read.own`, `activity.read.github`, `repos.*` reads, `pulls.read`, `deps.read`, `expertise.*`, `overview.read`, `overview.cards.read`, `org.*` reads, `alarms.org.read`). Derive these from the vocabulary rather than hand-listing where you can — a branch grant is one string and survives the vocabulary growing.
- **`control-hub-admin`** — inherits `member`, adds the branches today's `control-hub-admins` team unlocks: `alarms`, `scanners`, `widgets`, `access`, `config`, `activity`, `pulls`, `deps`, `repos`, `admin`.
- **`aws-admin`** — inherits `member`, adds `aws` and `activity.detailedLogging`.

Assign each member the preset matching their current team membership; somebody on both gets both.

`dryRun(file, members)` compares, for each member, the permissions they would hold under `file` against the `member`-preset baseline of what they can do today, and reports what they would lose. Owners are marked `isOrgOwner` so the screen can say they are exempt rather than implying the file gave them everything.

- [ ] **Step 4: Add the two endpoints**

In `src/routes/admin.ts`:
- `GET /dry-run` (gated `admin.people.read`) — builds `MemberSnapshot[]` from the org's members plus their current team membership, then returns `dryRun(currentFile, members)`.
- `POST /migrate` (gated `admin.people.assign`) — builds the same snapshot, calls `startingFile`, and saves it with `savePermissions(..., "Generate the starting permissions file")`. **Refuse with 409 if the file already has any people in it** — regenerating over a curated file would silently discard somebody's work.

Add assertions to `repro-admin.ts` that both routes exist, are gated, and that `/migrate` refuses a non-empty file.

- [ ] **Step 5: Verify and commit**

All suites pass; `tsc` clean; sweep `failing=0`.

```bash
git add src/permissions/migrate.ts src/routes/admin.ts repro-admin.ts
git commit -m "A starting file that makes the flip change nothing, and a diff that proves it"
```

---

### Task 3: The permission tree

**Files:**
- Create: `frontend/src/components/PermissionTree.tsx`
- Create: `frontend/src/api/admin.ts`

- [ ] **Step 1: The client**

Create `frontend/src/api/admin.ts` with typed wrappers over the six endpoints from Task 1 plus the two from Task 2. Follow the idiom in `frontend/src/api/access.ts`.

- [ ] **Step 2: The tree**

Create `frontend/src/components/PermissionTree.tsx`. It renders the vocabulary — fetched from `/api/admin/vocabulary`, never a client-side copy — as a collapsible tree grouped by top-level branch.

Requirements:
- **Tri-state per node**: all / some / none of the leaves beneath it.
- Clicking a branch grants or revokes the whole branch; clicking a leaf toggles that leaf.
- Each leaf shows its **origin**: *from preset X*, *granted here*, *revoked here*, or *not granted*. A permission whose origin is invisible is one nobody will dare change.
- **Writing back the shortest entry that expresses the intent**: if every leaf under `alarms` ends up granted, the saved entry is `grant: ["alarms"]`, not thirteen leaves. This is what keeps the file legible and what makes a later-added leaf included rather than missed.
- Collapsed to the top-level branches by default — 109 checkboxes open at once is not a screen anybody can use.

Follow the design system: use `SURFACE`, `TYPE` and the idiom classes from `frontend/src/design`, as `AccessPage.tsx` does. Do not hand-roll colours.

- [ ] **Step 3: Verify and commit**

`npx tsc -b --force` clean, `npx vite build` green.

```bash
git add frontend/src/components/PermissionTree.tsx frontend/src/api/admin.ts
git commit -m "A tree you can grant a branch of, or one leaf of"
```

---

### Task 4: The Admin tab

**Files:**
- Create: `frontend/src/pages/AdminPage.tsx`
- Modify: `frontend/src/router.tsx`, `frontend/src/components/Navbar.tsx`

- [ ] **Step 1: The four screens**

Create `frontend/src/pages/AdminPage.tsx` with a `Segmented` control over four views, following `AccessPage.tsx`'s structure:

- **People** — every org member, their preset, whether they have overrides, and a filter for "holds nothing". Clicking one opens Person.
- **Person** — the `PermissionTree` for that login, a free-text note, and Save (one commit). Show the person's origin explanations from `GET /person/:login`.
- **Presets** — create, edit, delete, and who holds each. Editing warns *"this will change N people"* before saving. Deleting is refused while anybody holds it, with the list.
- **Audit** — the commit history from `GET /audit`, rendered as who changed what and when. It must say plainly that **team membership changes do not appear here**, because membership lives on GitHub: the log is the history of policy, not of who held what.

Also on the tab, above the views: the **dry-run banner** when the file is empty or enforcement is off — *"Enforcement is off. With this file in force, N people would lose access to …"* with a link to run the migration.

- [ ] **Step 2: Wire the tab**

In `router.tsx`, add `/admin` behind `RequireAuth`. In `Navbar.tsx`, add the item with `permissions: ["admin.console.open"]` so it only appears for people who hold it.

- [ ] **Step 3: Verify and commit**

Frontend `tsc -b --force`, `vite build`, sweep `failing=0`.

```bash
git add -A
git commit -m "The Admin tab"
```

---

### Task 5: Close what stage 3 left open

**Files:**
- Modify: `src/routes/activity.ts`, `repro-permissiongates.ts`, `frontend/src/components/UserAvatar.tsx`, `src/permissions/vocabulary.ts` (only if needed), and two docs.

- [ ] **Step 1: The pagination interaction**

Stage 3's review found that `redactFeed` drops rows *after* the page was sliced to `limit`, so `exhausted` and `cursor` describe the pre-redaction page. A restricted viewer can get a nearly empty page marked exhausted and read it as "no more activity".

Fix: report the post-redaction count honestly. Either return the number dropped so the client can say "N rows hidden", or keep fetching until the page is full or the source is exhausted. Choose one, say why in a comment, and make the Activity page render it — an empty-looking tab with no explanation is the failure being fixed.

- [ ] **Step 2: Remove the `admin.*` exception**

`repro-permissiongates.ts` excuses `admin.*` from the "every permission is named by a route" check, with a note that stage 4 must remove it. Remove it now — Task 1 gave every `admin.*` key a route. If any key is still unnamed, wire it or delete it; do not restore the exception.

- [ ] **Step 3: Share the redaction constant**

`REDACTED_ACTOR` is duplicated as a literal in `activity.ts` and `UserAvatar.tsx`. Export it from one place and import it in the other.

- [ ] **Step 4: The documents this invalidates**

- `docs/auth/permissions-model.md` states **"Reading is open. Anyone signed in can see rules, findings, the access map and the activity log."** That is no longer true once enforcement is on. Rewrite that section to describe the permission model, the two-team-to-one change, and that `aws-guardrail-admins` is no longer read.
- `docs/operations/setup.md` — add the `control-hub-permissions` repository to setup: private, in the org, with a ruleset allowing only the App to commit. Note `PERMISSIONS_ENABLED` and that it stays off until the dry-run is clean.

- [ ] **Step 5: Verify and commit**

Everything green, both sweeps `failing=0`.

```bash
git add -A
git commit -m "Close what stage 3 deferred, and correct the documents it invalidated"
```

---

## What this plan deliberately does not do

- **It does not flip `PERMISSIONS_ENABLED`.** It builds the migration and the dry-run that make flipping safe. The flip is an operator's decision, taken once the dry-run says nobody loses anything they should keep.
- **It does not delete `aws-guardrail-admins`.** The app stops reading it; removing the team on GitHub is the operator's call.
- **It does not remove the old team gates.** They are harmless while the flag is off and are the fallback if the flip is reverted. Removing them is a follow-up, after the flip has held.
