# Permission Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read and write `permissions.json` from a private org repo with the App token, validate it, cache it briefly, and compose it with stage 1's engine into one question: *what may this login do?*

**Architecture:** A validator that decides a file is usable, a reader that fails closed when it is not, a writer that refuses to clobber a concurrent edit, and a subject builder that asks GitHub who someone is. All of it behind one composed entry point. Stage 1's engine stays pure and untouched.

**Tech Stack:** TypeScript, Octokit (already a dependency), `tsx` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-admin-console-permissions-design.md`
**Builds on:** `docs/superpowers/plans/2026-09-16-permission-engine.md` (merged)

## Global Constraints

- **No new npm dependencies.**
- **Stage 1 stays pure.** Do not add I/O to `vocabulary.ts`, `types.ts`, `presets.ts` or `evaluate.ts`. New I/O goes in new files.
- **Fail closed.** Any failure to read or validate the file yields *no permissions* for everyone except organization owners. There is **no cached fallback** — that was decided explicitly, so a revocation cannot outlive the file that made it.
- **The App token, never the caller's.** The permissions repo is private and the caller may not be able to see it; reading it with their token would make permissions depend on repo access.
- **AWS-only installs are inert.** When `process.env.AWS_ONLY === "true"` there is no GitHub org and no repo, so every check passes and the app behaves exactly as it does today.
- Tests follow the repo idiom: `repro-*.ts` at `github-control-hub/backend/`, run with `npx tsx`, local `check(name, ok, got?)` helper. No Jest/Vitest/Mocha.
- Run all commands from `github-control-hub/backend/`.
- Every task ends green: `npx tsc --noEmit -p tsconfig.json` passes before committing.

## File Structure

| File | Responsibility |
|---|---|
| `src/permissions/validate.ts` | Whether a parsed file is usable, and what is wrong with it. Pure. |
| `src/permissions/store.ts` | Reading and writing the file on GitHub, and the cache. |
| `src/permissions/subject.ts` | Who the caller is to GitHub: their teams, and whether they own the org. |
| `src/permissions/index.ts` | The one function the rest of the app calls. |
| `repro-permissionsfile.ts` | Validation and composition tests. |

---

### Task 1: Validation, and what a file gets wrong

**Files:**
- Create: `src/permissions/validate.ts`
- Test: `repro-permissionsfile.ts`

**Interfaces:**
- Consumes: `PermissionsFile`, `Preset` from `./types`; `presetProblems` from `./presets`; `isKnownNode` from `./vocabulary`.
- Produces: `FileProblem { where: string; what: string }`, `fileProblems(raw: unknown): FileProblem[]`, `unknownNodesIn(file: PermissionsFile): string[]`, `isUsable(raw: unknown): raw is PermissionsFile`.

- [ ] **Step 1: Write the failing test**

Create `repro-permissionsfile.ts`:

```ts
/**
 * The permissions file: whether it can be used, and what is wrong when it cannot.
 *
 * Stage 1's engine is pure and assumes a well-formed file. This is the gate that
 * makes that assumption safe. A file that fails here grants nobody anything,
 * which is the whole of "fail closed" — so the difference between *fatal* and
 * *tolerated* is the most load-bearing judgement in this module.
 *
 * Run:  npx tsx repro-permissionsfile.ts   from github-control-hub/backend
 */
import { fileProblems, unknownNodesIn, isUsable } from "./src/permissions/validate";
import type { PermissionsFile } from "./src/permissions/types";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const good: PermissionsFile = {
  version: 1,
  presets: { engineer: { name: "Engineer", grant: ["me", "activity.read.own"] } },
  teams: { platform: { presets: ["engineer"] } },
  people: { someone: { presets: ["engineer"], grant: ["config.export"] } },
};

console.log("a usable file");
{
  check("a good file has no problems", fileProblems(good).length === 0, fileProblems(good));
  check("  and is usable", isUsable(good));
}

console.log("\nshapes that are not a permissions file at all");
{
  for (const [name, raw] of [
    ["null", null], ["a string", "nope"], ["an array", []], ["a number", 7],
  ] as const) {
    check(`  ${name} is refused`, fileProblems(raw).length > 0 && !isUsable(raw));
  }
  check("a missing version is refused",
    fileProblems({ presets: {}, teams: {}, people: {} }).some(p => /version/.test(p.what)));
  check("a non-object presets map is refused",
    fileProblems({ version: 1, presets: [], teams: {}, people: {} }).some(p => /presets/.test(p.where)));
  // Absent sections are tolerated: an empty file is a valid file that grants
  // nothing, and refusing it would make the very first save impossible.
  check("absent sections are tolerated as empty",
    fileProblems({ version: 1 }).length === 0);
}

console.log("\nthings that make a file unusable");
{
  /**
   * The finding stage 1 deferred here: resolvePreset returns the rules it
   * gathered below a missing ancestor, so an unknown `inherits` would grant a
   * subset rather than failing. The gate is this validator, and it is why
   * nothing may evaluate a file that has not passed it.
   */
  const dangling = { version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} };
  check("a preset inheriting something that does not exist is fatal",
    fileProblems(dangling).some(p => /ghost/.test(p.what)), fileProblems(dangling));

  const cyclic = { version: 1,
    presets: { a: { name: "A", inherits: "b" }, b: { name: "B", inherits: "a" } },
    teams: {}, people: {} };
  check("a preset cycle is fatal", fileProblems(cyclic).some(p => /cycle/i.test(p.what)));

  const badRef = { version: 1, presets: {}, teams: {},
    people: { someone: { presets: ["no-such-preset"] } } };
  check("a person assigned a preset that does not exist is fatal",
    fileProblems(badRef).some(p => /no-such-preset/.test(p.what)), fileProblems(badRef));

  const badTeamRef = { version: 1, presets: {},
    teams: { platform: { presets: ["no-such-preset"] } }, people: {} };
  check("  and so is a team assigned one", fileProblems(badTeamRef).length > 0);

  check("a preset with no name is fatal",
    fileProblems({ version: 1, presets: { a: {} }, teams: {}, people: {} }).length > 0);
}

console.log("\nthings that are tolerated and reported");
{
  /**
   * An app upgrade that removes a permission must not lock the organization
   * out of the screen that would fix it. So an unknown node is ignored at
   * evaluation time — stage 1's decideLeaf already skips it — and named here
   * so the admin screen can offer to clean it up.
   */
  const stale: PermissionsFile = { version: 1, presets: {}, teams: {},
    people: { someone: { grant: ["alarms.org.create", "alarms.removedLastYear"] } } };
  check("an unknown node does not make a file unusable",
    fileProblems(stale).length === 0 && isUsable(stale));
  check("  but it is reported",
    unknownNodesIn(stale).includes("alarms.removedLastYear"), unknownNodesIn(stale));
  check("  and a known one is not",
    !unknownNodesIn(stale).includes("alarms.org.create"));
  check("  branches count as known",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { x: { grant: ["alarms"] } } }).length === 0);
  check("  and nodes inside presets and teams are reported too",
    unknownNodesIn({ version: 1,
      presets: { p: { name: "P", grant: ["made.up.one"] } },
      teams: { t: { revoke: ["also.made.up"] } }, people: {} },
    ).sort().join() === "also.made.up,made.up.one");
  check("  each unknown node reported once",
    unknownNodesIn({ version: 1, presets: {}, teams: {},
      people: { a: { grant: ["ghost.node"] }, b: { grant: ["ghost.node"] } } }).length === 1);
}

console.log("\nevery problem says where it is");
{
  const p = fileProblems({ version: 1, presets: { a: { name: "A", inherits: "ghost" } }, teams: {}, people: {} });
  check("a problem names its location", p.every(x => x.where.length > 0), p);
  check("  and what is wrong", p.every(x => x.what.length > 0));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `Cannot find module './src/permissions/validate'`

- [ ] **Step 3: Write the validator**

Create `src/permissions/validate.ts`:

```ts
import type { PermissionsFile, Preset, PermissionEntry } from "./types";
import { presetProblems } from "./presets";
import { isKnownNode } from "./vocabulary";

/**
 * Whether a parsed file may be used, and what is wrong with it when it may not.
 *
 * Stage 1's engine assumes a well-formed file — `resolvePreset` returns the
 * rules it gathered below a missing ancestor rather than refusing, which grants
 * a subset where the spec wants nothing. This is the gate that makes that
 * assumption safe, so **nothing may evaluate a file that has not passed here.**
 *
 * The line between fatal and tolerated is the judgement that matters:
 *
 *   - **Fatal** is anything that makes the file mean something *other* than
 *     what it says: a dangling `inherits`, a cycle, a person assigned a preset
 *     that does not exist. Evaluating those silently produces a different
 *     answer from the one written down, and a permissions file that quietly
 *     means something else is worse than no file.
 *   - **Tolerated** is anything that merely names something this version of the
 *     app no longer has. An upgrade that removes a permission must not lock the
 *     organization out of the screen that would put it back, so unknown nodes
 *     are ignored at evaluation time and reported by `unknownNodesIn` for the
 *     admin screen to offer to clean up.
 */

export interface FileProblem {
  /** Where in the file: `presets.engineer`, `people.someone`. */
  where: string;
  what: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `grant` and `revoke` from one entry, whatever shape it arrived in. */
function nodesOf(entry: unknown): string[] {
  if (!isObject(entry)) return [];
  const out: string[] = [];
  for (const key of ["grant", "revoke"] as const) {
    const list = entry[key];
    if (Array.isArray(list)) out.push(...list.filter(v => typeof v === "string"));
  }
  return out;
}

export function fileProblems(raw: unknown): FileProblem[] {
  const problems: FileProblem[] = [];

  if (!isObject(raw)) {
    return [{ where: "file", what: "is not an object" }];
  }
  if (typeof raw.version !== "number") {
    problems.push({ where: "file", what: "has no numeric version" });
  }

  // Absent sections are an empty file, which is valid and grants nothing.
  // Refusing them would make the very first save impossible.
  for (const section of ["presets", "teams", "people"] as const) {
    if (raw[section] !== undefined && !isObject(raw[section])) {
      problems.push({ where: section, what: "is not an object" });
    }
  }
  if (problems.length > 0) return problems;

  const presets = (isObject(raw.presets) ? raw.presets : {}) as Record<string, Preset>;
  const teams = (isObject(raw.teams) ? raw.teams : {}) as Record<string, PermissionEntry & { presets?: string[] }>;
  const people = (isObject(raw.people) ? raw.people : {}) as Record<string, PermissionEntry & { presets?: string[] }>;

  for (const [id, preset] of Object.entries(presets)) {
    if (!isObject(preset)) {
      problems.push({ where: `presets.${id}`, what: "is not an object" });
      continue;
    }
    if (typeof preset.name !== "string" || preset.name.length === 0) {
      problems.push({ where: `presets.${id}`, what: "has no name" });
    }
  }

  // Cycles, over-deep chains and dangling parents, from stage 1's own checker
  // rather than a second implementation that could disagree with it.
  for (const message of presetProblems(presets)) {
    problems.push({ where: "presets", what: message });
  }

  for (const [label, table] of [["people", people], ["teams", teams]] as const) {
    for (const [key, entry] of Object.entries(table)) {
      if (!isObject(entry)) {
        problems.push({ where: `${label}.${key}`, what: "is not an object" });
        continue;
      }
      for (const id of entry.presets ?? []) {
        if (!presets[id]) {
          problems.push({ where: `${label}.${key}`, what: `is assigned preset "${id}", which does not exist` });
        }
      }
    }
  }

  return problems;
}

/** A file that may be evaluated. */
export function isUsable(raw: unknown): raw is PermissionsFile {
  return fileProblems(raw).length === 0;
}

/**
 * Nodes named anywhere in the file that this version of the app does not have.
 *
 * Not fatal, by design — see the note at the top. Reported so the admin screen
 * can say "unknown, ignored" rather than leaving somebody to wonder why a
 * permission they can see written down does nothing.
 */
export function unknownNodesIn(file: PermissionsFile): string[] {
  const seen = new Set<string>();
  const consider = (entry: unknown) => {
    for (const node of nodesOf(entry)) {
      if (!isKnownNode(node)) seen.add(node);
    }
  };
  for (const preset of Object.values(file.presets ?? {})) consider(preset);
  for (const team of Object.values(file.teams ?? {})) consider(team);
  for (const person of Object.values(file.people ?? {})) consider(person);
  return [...seen];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/validate.ts repro-permissionsfile.ts
git commit -m "Decide whether a permissions file may be used, and say what is wrong"
```

---

### Task 2: Reading the file from GitHub

**Files:**
- Create: `src/permissions/store.ts`
- Modify: `repro-permissionsfile.ts` (append a section)

**Interfaces:**
- Consumes: `isUsable`, `fileProblems` (Task 1); `PermissionsFile`, `emptyFile` from `./types`.
- Produces: `PERMISSIONS_REPO`, `PERMISSIONS_PATH`, `LoadedPermissions { file: PermissionsFile; sha: string | null; source: "github" | "absent" }`, `LoadFailure { reason: "aws-only" | "no-token" | "unreachable" | "unparseable" | "invalid"; detail: string; problems?: string[] }`, `loadPermissions(): Promise<LoadedPermissions | LoadFailure>`, `isFailure(r): r is LoadFailure`, `forgetPermissions(): void`, `decodeFileContent(base64: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissionsfile.ts`, immediately before the final two lines:

```ts
console.log("\nreading the file");
{
  // Decoding is the only part of the reader that is pure enough to test
  // directly; the rest needs GitHub and is exercised by the route tests in
  // stage 3. Base64 with embedded newlines is what the contents API returns.
  check("base64 content is decoded, newlines and all",
    decodeFileContent(Buffer.from('{"version":1}', "utf8").toString("base64")) === '{"version":1}');
  const wrapped = Buffer.from('{"version":1}', "utf8").toString("base64").match(/.{1,4}/g)!.join("\n");
  check("  and GitHub's line-wrapped base64 too",
    decodeFileContent(wrapped) === '{"version":1}');

  check("a failure is distinguishable from a load",
    isFailure({ reason: "unreachable", detail: "x" })
    && !isFailure({ file: emptyFile(), sha: null, source: "absent" }));

  // The decision that must not soften: a failure yields nothing, never a
  // remembered copy. A cached grant is a grant nobody can revoke.
  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");
  check("nothing keeps a last-known-good copy",
    !/lastKnownGood|lastGood|fallbackFile/.test(store),
    "a cached grant outlives the file that granted it");
  check("  and the cache is cleared rather than served on failure",
    /forgetPermissions/.test(store));
}
```

Extend the imports at the top of `repro-permissionsfile.ts`:

```ts
import fs from "node:fs";
import { emptyFile } from "./src/permissions/types";
import { decodeFileContent, isFailure, forgetPermissions } from "./src/permissions/store";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `Cannot find module './src/permissions/store'`

- [ ] **Step 3: Write the store**

Create `src/permissions/store.ts`:

```ts
import { createOctokit, getSystemToken, getOrg } from "../github/client";
import { emptyFile, type PermissionsFile } from "./types";
import { fileProblems, isUsable } from "./validate";

/**
 * Where the permissions live, and how they are read.
 *
 * A private repository in the organization, holding one JSON file. The
 * repository's own ruleset is the security boundary — only the App may commit —
 * and its git history is the audit log. That was chosen deliberately over
 * keeping the authority in DynamoDB: the file is reviewable, diffable and
 * recoverable by hand, which matters most on the day the app is the thing that
 * is broken.
 *
 * Read with the **App token**, never the caller's. The repository is private
 * and most callers cannot see it; reading it as them would make a person's
 * permissions depend on their access to the repository that stores permissions,
 * which is a circle.
 *
 * **There is no cached fallback.** Any failure yields nothing for everybody
 * except organization owners, who are exempt in the engine. Serving a
 * last-known-good copy was considered and rejected: a cached grant is a grant
 * nobody can revoke, and somebody removing a permission during an incident has
 * to be able to believe it took effect. The sixty-second TTL below is the whole
 * window in which a revocation can still be honoured — bounded and stated,
 * rather than however long an outage lasts.
 */

export const PERMISSIONS_REPO = process.env.PERMISSIONS_REPO || "control-hub-permissions";
export const PERMISSIONS_PATH = process.env.PERMISSIONS_PATH || "permissions.json";

/** How long a successful read is reused. Matches the team-membership cache. */
const TTL_MS = 60_000;

export interface LoadedPermissions {
  file: PermissionsFile;
  /** The blob sha, needed to write without clobbering a concurrent edit. */
  sha: string | null;
  /** `absent` means the repo is there and the file is not — an ordinary first-run state. */
  source: "github" | "absent";
}

export interface LoadFailure {
  reason: "aws-only" | "no-token" | "unreachable" | "unparseable" | "invalid";
  detail: string;
  /** Present for `invalid`: what the validator objected to, for the admin screen. */
  problems?: string[];
}

export function isFailure(r: LoadedPermissions | LoadFailure): r is LoadFailure {
  return (r as LoadFailure).reason !== undefined;
}

/**
 * GitHub's contents API returns base64 wrapped at 60 characters. `Buffer.from`
 * tolerates the newlines, but stripping them is cheap and makes the intent
 * legible rather than depending on that tolerance.
 */
export function decodeFileContent(base64: string): string {
  return Buffer.from(base64.replace(/\s+/g, ""), "base64").toString("utf8");
}

let cache: { at: number; value: LoadedPermissions | LoadFailure } | null = null;

/** Drop the cached read. Called after every write, so a change is live at once. */
export function forgetPermissions(): void {
  cache = null;
}

export async function loadPermissions(now = Date.now()): Promise<LoadedPermissions | LoadFailure> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = await read();
  cache = { at: now, value };
  return value;
}

async function read(): Promise<LoadedPermissions | LoadFailure> {
  // An AWS-only install has no GitHub organization and no repository to hold a
  // file. The system is inert there; stage 3's gate reads this reason and lets
  // everything through.
  if (process.env.AWS_ONLY === "true") {
    return { reason: "aws-only", detail: "This deployment has no GitHub organization." };
  }

  const token = getSystemToken();
  if (!token) {
    return { reason: "no-token", detail: "The GitHub App's credentials are not loaded." };
  }

  const octokit = createOctokit(token, "Permissions");
  let data: any;
  try {
    const res = await octokit.rest.repos.getContent({
      owner: getOrg(), repo: PERMISSIONS_REPO, path: PERMISSIONS_PATH,
    });
    data = res.data;
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    // 404 is either "no repository" or "no file". Both are ordinary first-run
    // states and both mean nobody has been granted anything yet, which is the
    // correct default rather than an error.
    if (status === 404) {
      return { file: emptyFile(), sha: null, source: "absent" };
    }
    return { reason: "unreachable", detail: err?.message ?? String(err) };
  }

  if (Array.isArray(data) || typeof data?.content !== "string") {
    return { reason: "unparseable", detail: `${PERMISSIONS_PATH} is not a file.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeFileContent(data.content));
  } catch (err: any) {
    return { reason: "unparseable", detail: err?.message ?? "not valid JSON" };
  }

  if (!isUsable(parsed)) {
    const problems = fileProblems(parsed).map(p => `${p.where}: ${p.what}`);
    return {
      reason: "invalid",
      detail: `${PERMISSIONS_PATH} cannot be used: ${problems[0]}`,
      problems,
    };
  }

  return { file: parsed, sha: data.sha ?? null, source: "github" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/store.ts repro-permissionsfile.ts
git commit -m "Read permissions from the org repo, and fail closed when we cannot"
```

---

### Task 3: Writing the file without clobbering a concurrent edit

**Files:**
- Modify: `src/permissions/store.ts`
- Modify: `repro-permissionsfile.ts` (append a section)

**Interfaces:**
- Consumes: everything in Task 2.
- Produces: `WriteResult { ok: true; sha: string } | { ok: false; reason: "conflict" | "invalid" | "failed"; detail: string }`, `savePermissions(next: PermissionsFile, sha: string | null, actor: string, summary: string): Promise<WriteResult>`, `commitMessageFor(actor: string, summary: string): string`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissionsfile.ts`, before the final two lines:

```ts
console.log("\nwriting the file");
{
  check("the commit message names the change and who made it",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login")
      === "Grant alarms.org.create to other-login\n\nBy some-login via Control Hub",
    commitMessageFor("some-login", "Grant alarms.org.create to other-login"));

  const store = fs.readFileSync("./src/permissions/store.ts", "utf8");

  /**
   * Two administrators on the same screen must not silently discard each
   * other's work. The sha the editor loaded is sent back; a changed one means
   * somebody saved first, and the write is refused rather than applied.
   */
  check("the write sends the sha it read",
    /sha: sha \?\? undefined|sha:\s*sha/.test(store), "without it a concurrent save is lost");
  check("  and a 409 from GitHub is reported as a conflict",
    /409/.test(store) && /"conflict"/.test(store));

  // Writing a file that cannot be read back is how an admin locks the org out.
  check("a file that would not validate is refused before it is written",
    /isUsable\(next\)/.test(store) || /fileProblems\(next\)/.test(store));

  check("a successful write drops the cache",
    /forgetPermissions\(\)/.test(store.slice(store.indexOf("savePermissions"))),
    "otherwise a change you just made is invisible for up to a minute");
}
```

Extend the store import in `repro-permissionsfile.ts`:

```ts
import {
  decodeFileContent, isFailure, forgetPermissions, commitMessageFor,
} from "./src/permissions/store";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `commitMessageFor is not a function`

- [ ] **Step 3: Write the writer**

Append to `src/permissions/store.ts`:

```ts
export type WriteResult =
  | { ok: true; sha: string }
  | { ok: false; reason: "conflict" | "invalid" | "failed"; detail: string };

/**
 * The commit message, which is the audit log.
 *
 * Git history is the record of who changed whose permissions and when — chosen
 * over a separate audit table precisely because it cannot be edited from inside
 * the app. So the message has to carry the actor: the committer is the App for
 * every commit, and without the actor named in the body the history says only
 * that something changed.
 */
export function commitMessageFor(actor: string, summary: string): string {
  return `${summary}\n\nBy ${actor} via Control Hub`;
}

/**
 * Save the file, refusing rather than clobbering.
 *
 * `sha` is the blob the editor loaded. GitHub rejects the write if the file has
 * moved on, which is what stops two administrators on the same screen from
 * silently discarding each other's work — the second one is told, re-reads, and
 * re-applies.
 *
 * The file is validated *before* it is written. Writing one that cannot be read
 * back is how an administrator locks the organization out of the screen that
 * would fix it, and the validator is the same one the reader uses, so the two
 * cannot disagree about what is acceptable.
 */
export async function savePermissions(
  next: PermissionsFile, sha: string | null, actor: string, summary: string,
): Promise<WriteResult> {
  if (!isUsable(next)) {
    const problems = fileProblems(next).map(p => `${p.where}: ${p.what}`);
    return { ok: false, reason: "invalid", detail: problems.join("; ") };
  }

  const token = getSystemToken();
  if (!token) return { ok: false, reason: "failed", detail: "The GitHub App's credentials are not loaded." };

  const body = JSON.stringify(next, null, 2) + "\n";
  try {
    const octokit = createOctokit(token, "Permissions");
    const res = await octokit.rest.repos.createOrUpdateFileContents({
      owner: getOrg(),
      repo: PERMISSIONS_REPO,
      path: PERMISSIONS_PATH,
      message: commitMessageFor(actor, summary),
      content: Buffer.from(body, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    });
    // The change is live immediately rather than up to a minute later, which is
    // the difference between a screen that reflects your edit and one that
    // appears to have ignored it.
    forgetPermissions();
    return { ok: true, sha: (res.data as any)?.content?.sha ?? "" };
  } catch (err: any) {
    const status = err?.status ?? err?.response?.status;
    if (status === 409 || status === 422) {
      return {
        ok: false, reason: "conflict",
        detail: "Somebody else saved while this was open. Reload and re-apply your change.",
      };
    }
    return { ok: false, reason: "failed", detail: err?.message ?? String(err) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/store.ts repro-permissionsfile.ts
git commit -m "Save permissions without discarding a concurrent edit"
```

---

### Task 4: Who the caller is to GitHub

**Files:**
- Create: `src/permissions/subject.ts`
- Modify: `repro-permissionsfile.ts` (append a section)

**Interfaces:**
- Consumes: `createOctokit`, `getSystemToken`, `getOrg` from `../github/client`; `Subject` from `./evaluate`.
- Produces: `subjectFor(login: string, userToken?: string): Promise<Subject>`, `forgetSubjects(login?: string): void`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissionsfile.ts`, before the final two lines:

```ts
console.log("\nwho the caller is");
{
  const subject = fs.readFileSync("./src/permissions/subject.ts", "utf8");

  /**
   * The exemption that keeps a broken file from locking everybody out. It has
   * to be read from GitHub rather than from the permissions file, or the file
   * could revoke the exemption that exists to survive the file.
   */
  check("organization ownership is read from GitHub, not from the file",
    /getMembershipForUser/.test(subject) && /role === "admin"/.test(subject));
  check("  and never from the permissions file",
    !/loadPermissions|PermissionsFile/.test(subject));

  /**
   * One paginated call, not one per team. The obvious implementation — list
   * every team in the org, then ask "is this person in it" for each — is
   * O(teams) GitHub calls for every permission load, on every request. An org
   * with fifty teams would spend fifty calls answering one question.
   */
  check("the caller's teams are read in one paginated call",
    /listForAuthenticatedUser/.test(subject));
  check("  not by asking per team",
    !/getMembershipForUserInOrg/.test(subject),
    "that is O(teams) calls per permission load");
  check("  paged the way the rest of this codebase pages",
    /per_page: 100/.test(subject) && /page\b/.test(subject));

  /**
   * Fail closed, the same rule as the file: an unreadable membership means the
   * person keeps only what their own entries and presets give them. Not a
   * fallback to a remembered list.
   */
  check("an unreadable membership yields no teams rather than the last known set",
    /catch/.test(subject) && !/lastKnownTeams|cachedTeams\b/.test(subject));

  check("answers are cached, so a screen is not a burst of GitHub calls",
    /TTL|expires/.test(subject) && /forgetSubjects/.test(subject));
}
```

Extend the imports:

```ts
// (subject.ts is read as text above; no value import is needed for this section)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `ENOENT ... src/permissions/subject.ts`

- [ ] **Step 3: Write the subject builder**

Create `src/permissions/subject.ts`:

```ts
import { createOctokit, getSystemToken, getOrg } from "../github/client";
import type { Subject } from "./evaluate";

/**
 * Who somebody is, as far as GitHub is concerned: the teams they are in, and
 * whether they own the organization.
 *
 * Both are read from GitHub rather than from the permissions file, and that is
 * not an implementation detail. Organization owners are exempt from every
 * permission check so that an empty or broken file cannot lock everybody out of
 * the screen that would fix it — and an exemption stored *in* the file would be
 * revocable by the same file it exists to survive.
 *
 * Two different tokens, on purpose. Organization ownership is read with the
 * **App token**, which can see a membership the caller might not. The caller's
 * **own token** reads their teams, because `listForAuthenticatedUser` answers
 * that in one paginated call where the App-token route would cost one call per
 * team in the organization — and because the only membership that token can
 * read is the caller's own, which is the only one being asked about.
 *
 * Cached for the same minute as the file. Failing to read yields *no* teams
 * rather than a remembered set, for the same reason the file has no cached
 * fallback: a membership that outlives its source is a grant nobody can revoke.
 */

const TTL_MS = 60_000;

interface Entry { at: number; subject: Subject }
const cache = new Map<string, Entry>();

export function forgetSubjects(login?: string): void {
  if (!login) { cache.clear(); return; }
  cache.delete(login.toLowerCase());
}

export async function subjectFor(login: string, userToken?: string, now = Date.now()): Promise<Subject> {
  const key = login.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.subject;

  const subject: Subject = { login, teamSlugs: [], isOrgOwner: false };
  const token = getSystemToken() || userToken;
  if (!token) return subject;

  const octokit = createOctokit(token, "Permissions");
  const org = getOrg();

  try {
    const { data } = await octokit.rest.orgs.getMembershipForUser({ org, username: login });
    subject.isOrgOwner = data.role === "admin";
  } catch (err: any) {
    // A 404 is the ordinary "not a member" answer. Anything else is a question
    // we could not ask, and the safe answer to "are you an owner" is no.
    if ((err?.status ?? err?.response?.status) !== 404) {
      console.warn(`[permissions] Could not read org membership for "${login}":`, err?.message ?? err);
    }
  }

  /**
   * The caller's own teams, in one paginated call, using *their* token.
   *
   * The obvious alternative — list every team in the organization with the App
   * token and ask "is this person in it" for each — costs one GitHub call per
   * team, per person, per permission load. An organization with fifty teams
   * would spend fifty calls answering one question, on every request.
   *
   * `listForAuthenticatedUser` answers it in one. It needs the caller's token,
   * which is safe for exactly the reason `authorizationService` already relies
   * on: the only membership that token can read is the caller's own, and the
   * caller's own is the only one being asked about. Without a user token there
   * are no teams — fail closed, like everything else here.
   */
  if (userToken) {
    try {
      const asUser = createOctokit(userToken, "Permissions");
      const slugs: string[] = [];
      for (let page = 1; page <= 10; page++) {
        const { data } = await asUser.rest.teams.listForAuthenticatedUser({ per_page: 100, page });
        for (const team of data) {
          if (team.organization?.login?.toLowerCase() === org.toLowerCase()) slugs.push(team.slug);
        }
        if (data.length < 100) break;
      }
      subject.teamSlugs = slugs;
    } catch (err: any) {
      console.warn(`[permissions] Could not read teams for "${login}":`, err?.message ?? err);
    }
  }

  cache.set(key, { at: now, subject });
  return subject;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/subject.ts repro-permissionsfile.ts
git commit -m "Read who the caller is from GitHub, never from the file"
```

---

### Task 5: The one question the app asks

**Files:**
- Create: `src/permissions/index.ts`
- Modify: `repro-permissionsfile.ts` (append a section)

**Interfaces:**
- Consumes: everything above.
- Produces: `Access { permissions: PermissionSet; inert: boolean; failure: LoadFailure | null; unknownNodes: string[] }`, `accessFor(login: string, userToken?: string): Promise<Access>`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissionsfile.ts`, before the final two lines:

```ts
console.log("\nthe one question the app asks");
{
  const index = fs.readFileSync("./src/permissions/index.ts", "utf8");

  check("it composes the store, the subject and the engine",
    /loadPermissions/.test(index) && /subjectFor/.test(index) && /permissionsFor/.test(index));

  /**
   * AWS-only installs have no GitHub organization and no repository to hold a
   * file, so the whole system is inert there and the app behaves as it does
   * today. Anything else would make an AWS deployment depend on a GitHub
   * feature it does not have.
   */
  check("an AWS-only install is inert rather than locked out",
    /aws-only/.test(index) && /inert/.test(index));

  /**
   * Every other failure is closed, not open. An owner still gets in, because
   * the engine exempts them and the subject is read from GitHub rather than
   * from the file that just failed to load.
   */
  check("every other failure grants an empty file, not a bypass",
    /emptyFile\(\)/.test(index));
  check("  and the reason travels with it, for the screen to show",
    /failure/.test(index));

  check("unknown nodes are surfaced rather than swallowed",
    /unknownNodesIn/.test(index));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissionsfile.ts`
Expected: FAIL — `ENOENT ... src/permissions/index.ts`

- [ ] **Step 3: Write the entry point**

Create `src/permissions/index.ts`:

```ts
import { loadPermissions, isFailure, type LoadFailure } from "./store";
import { subjectFor } from "./subject";
import { permissionsFor, type PermissionSet } from "./evaluate";
import { unknownNodesIn } from "./validate";
import { emptyFile } from "./types";

export * from "./types";
export { PERMISSIONS, isLeaf, isKnownNode, leavesUnder } from "./vocabulary";
export { forgetPermissions, savePermissions, loadPermissions, isFailure } from "./store";
export { forgetSubjects, subjectFor } from "./subject";
export { fileProblems, unknownNodesIn, isUsable } from "./validate";

/**
 * What one person may do, all the way from GitHub.
 *
 * The single function the rest of the app calls. Everything below it is
 * replaceable; this signature is not.
 */
export interface Access {
  permissions: PermissionSet;
  /**
   * True on an AWS-only install, where there is no GitHub organization and no
   * repository to hold a file. The gate lets everything through — anything else
   * would make an AWS deployment depend on a GitHub feature it does not have.
   */
  inert: boolean;
  /**
   * Why the file could not be used, when it could not. The permissions above
   * are then empty, and an organization owner still gets in — the exemption
   * lives in the engine and the subject is read from GitHub, not from the file
   * that just failed.
   */
  failure: LoadFailure | null;
  /** Nodes the file names that this version of the app does not have. */
  unknownNodes: string[];
}

export async function accessFor(login: string, userToken?: string): Promise<Access> {
  const [loaded, subject] = await Promise.all([
    loadPermissions(),
    subjectFor(login, userToken),
  ]);

  if (isFailure(loaded)) {
    return {
      permissions: permissionsFor(emptyFile(), subject),
      inert: loaded.reason === "aws-only",
      failure: loaded,
      unknownNodes: [],
    };
  }

  return {
    permissions: permissionsFor(loaded.file, subject),
    inert: false,
    failure: null,
    unknownNodes: unknownNodesIn(loaded.file),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissionsfile.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Run the whole backend sweep**

Run:
```bash
bad=0; for f in repro-*.ts; do out=$(npx tsx "$f" 2>&1); \
  if printf '%s\n' "$out" | grep -qE '^[[:space:]]*(FAIL|✗)|did not hold'; then \
  bad=$((bad+1)); echo "=== $f"; fi; done; echo "failing=$bad"
```
Expected: `failing=0`. Report the actual number.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/index.ts repro-permissionsfile.ts
git commit -m "One question: what may this login do"
```

---

## What this stage deliberately does not do

- **No enforcement.** No middleware, no route changes. Nothing calls `accessFor` yet.
- **No admin UI, no migration.** Stage 4.
- **No repository creation.** Stage 4's admin screen offers that; stage 2 treats a missing repo as "nobody has been granted anything yet", which is the correct default.

## Next plans

- **Stage 3 — enforcement:** `requirePermission` middleware on ~155 endpoints behind `PERMISSIONS_ENABLED`, the no-access screen, and the build-time completeness assertions.
- **Stage 4 — the Admin tab:** four screens, the migration generator, the dry-run diff, then the flip.
