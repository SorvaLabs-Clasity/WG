# Permission Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the vocabulary and the pure evaluation engine that decides, for one person, which permissions they hold — with no I/O, no GitHub, no Express, and no storage.

**Architecture:** A flat list of permission leaves whose dotted keys *are* the group tree. Grants and revokes may name any node; evaluation expands nodes to leaves and resolves conflicts by longest prefix, then by layer (team < preset < person), then revoke-over-grant. Everything in this plan is a pure function over plain data, so it is fully testable before anything depends on it.

**Tech Stack:** TypeScript, Node, `tsx` for running tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-15-admin-console-permissions-design.md`

## Global Constraints

- **No new npm dependencies.** The app ships to desktops; every package is weight.
- **Pure functions only in this stage.** No `fetch`, no Octokit, no `fs`, no `process.env`. Stage 2 adds I/O around this.
- **Deny by default.** A leaf matched by no entry is denied. There is no implicit grant anywhere in this stage.
- **A node is a group or a permission, never both.** No permission key may be a dotted ancestor of another. This is asserted, not assumed.
- **Tests follow the repo's existing idiom**: a `repro-*.ts` file at `github-control-hub/backend/`, run with `npx tsx`, using a local `check(name, ok, got?)` helper that prints `PASS`/`FAIL` and exits non-zero on failure. Do **not** introduce Jest, Vitest or Mocha.
- Run all commands from `github-control-hub/backend/`.
- Every task ends green: `npx tsc --noEmit -p tsconfig.json` must pass before committing.

## File Structure

| File | Responsibility |
|---|---|
| `src/permissions/vocabulary.ts` | The leaf list, and tree helpers derived from it. Knows nothing about people. |
| `src/permissions/types.ts` | The shapes of the permissions file: entries, presets, teams, people. |
| `src/permissions/presets.ts` | Resolving a preset (and its `inherits` chain) into a flat rule list. |
| `src/permissions/evaluate.ts` | Collecting rules across the three layers and resolving them into an answer. |
| `repro-permissions.ts` | The suite covering all of the above. |

Split this way because `vocabulary.ts` changes whenever the app grows a feature, while `evaluate.ts` should never change again once correct. Keeping them apart means a new permission is a one-line edit to a file with no logic in it.

---

### Task 1: The vocabulary

**Files:**
- Create: `src/permissions/vocabulary.ts`
- Test: `repro-permissions.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PermissionLeaf { key: string; label: string; addedIn: number }`, `PERMISSIONS: readonly PermissionLeaf[]`, `LEAF_KEYS: ReadonlySet<string>`, `isLeaf(key: string): boolean`, `isKnownNode(node: string): boolean`, `leavesUnder(node: string): string[]`, `vocabularyProblems(): string[]`.

- [ ] **Step 1: Write the failing test**

Create `repro-permissions.ts`:

```ts
/**
 * The permission engine: what one person may do, decided from plain data.
 *
 * Everything here is a pure function. No GitHub, no storage, no Express — those
 * arrive in stage 2 and wrap this rather than change it.
 *
 * Run:  npx tsx repro-permissions.ts   from github-control-hub/backend
 */
import {
  PERMISSIONS, LEAF_KEYS, isLeaf, isKnownNode, leavesUnder, vocabularyProblems,
} from "./src/permissions/vocabulary";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

console.log("the vocabulary");
{
  check("there are permissions at all", PERMISSIONS.length > 100, PERMISSIONS.length);

  /**
   * The rule the whole tree rests on. If `activity.read.app` were both a
   * checkable permission and the parent of `activity.read.app.actor`, granting
   * it would mean two different things depending on who was asking, and the
   * tri-state checkbox in the admin UI would have nothing coherent to show.
   */
  check("no key is an ancestor of another", vocabularyProblems().length === 0,
    vocabularyProblems());

  check("every key is unique",
    new Set(PERMISSIONS.map(p => p.key)).size === PERMISSIONS.length);

  check("every key is dotted lower-case segments",
    PERMISSIONS.every(p => /^[a-z]+(\.[a-zA-Z]+)+$/.test(p.key)),
    PERMISSIONS.filter(p => !/^[a-z]+(\.[a-zA-Z]+)+$/.test(p.key)).map(p => p.key));

  check("every key is described", PERMISSIONS.every(p => p.label.length > 3));

  check("a leaf is recognized", isLeaf("alarms.org.create"));
  check("  and a branch is not a leaf", !isLeaf("alarms.org"));
  check("  while both are known nodes",
    isKnownNode("alarms.org.create") && isKnownNode("alarms.org") && isKnownNode("alarms"));
  check("  and an invented one is not", !isKnownNode("alarms.invented"));

  // A branch expands to every leaf beneath it. This is what makes ~120
  // permissions assignable without ticking 120 boxes.
  const orgAlarms = leavesUnder("alarms.org");
  check("a branch expands to its leaves",
    orgAlarms.length === 4 && orgAlarms.every(k => k.startsWith("alarms.org.")),
    orgAlarms);
  check("  a leaf expands to itself",
    leavesUnder("alarms.org.create").join() === "alarms.org.create");
  check("  and an unknown node expands to nothing",
    leavesUnder("nonsense").length === 0);

  // Prefix matching must respect segment boundaries, or "me" would match
  // "members.read" and quietly grant a tab nobody chose.
  check("a branch does not match a key that merely starts with its text",
    !leavesUnder("activity.read.app").includes("activity.read.github"),
    leavesUnder("activity.read.app"));

  check("the redaction split exists, as two leaves under a branch",
    isLeaf("activity.read.app.rows") && isLeaf("activity.read.app.actor")
    && !isLeaf("activity.read.app") && leavesUnder("activity.read.app").length === 2);

  check("LEAF_KEYS agrees with PERMISSIONS", LEAF_KEYS.size === PERMISSIONS.length);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissions.ts`
Expected: FAIL — `Cannot find module './src/permissions/vocabulary'`

- [ ] **Step 3: Write the vocabulary**

Create `src/permissions/vocabulary.ts`:

```ts
/**
 * Every permission this app has, and the tree they form.
 *
 * The dots are not decoration. `alarms.org.create` sits under `alarms.org`,
 * which sits under `alarms`, and a grant may name any of the three — which is
 * what makes a hundred-odd permissions assignable without ticking a hundred
 * boxes. The tree is derived from these keys rather than declared separately,
 * so the two cannot disagree.
 *
 * **A node is a group or a permission, never both.** No key here may be a
 * dotted ancestor of another; `vocabularyProblems()` enforces it and the test
 * suite fails the build if it is violated. Without that rule, granting a node
 * that is both would mean two different things depending on who was asking.
 *
 * `addedIn` is the vocabulary version a leaf first appeared in. A person
 * holding a branch holds leaves added under it later — that is what makes a
 * group a group — and this field is how the admin screen can say so rather
 * than letting an upgrade widen access silently.
 */

export interface PermissionLeaf {
  /** Dotted, lower-case first segment, camelCase within a segment. */
  key: string;
  /** Shown in the admin tree. A sentence fragment, not a restatement of the key. */
  label: string;
  addedIn: number;
}

/** Bump when leaves are added. Never reuse a number. */
export const VOCABULARY_VERSION = 1;

const L = (key: string, label: string, addedIn = 1): PermissionLeaf => ({ key, label, addedIn });

export const PERMISSIONS: readonly PermissionLeaf[] = [
  // ── My work: all of it is about you and nobody else ────────────────
  L("me.work.read", "Your queue: your pull requests, reviews and checks"),
  L("me.push.check", "Ask why a push would be refused"),
  L("me.repos.read", "Your own repository list"),
  L("me.alerts.read", "Your notification settings"),
  L("me.alerts.manage", "Change your notification settings"),
  L("me.alerts.test", "Send yourself a test notification"),
  L("me.alarms.read", "Your own alarms"),
  L("me.alarms.manage", "Create, edit and delete your own alarms"),
  L("me.destination.read", "Where your notifications are sent"),
  L("me.destination.manage", "Change where your notifications are sent"),
  L("me.widgets.read", "Your own cards"),
  L("me.widgets.manage", "Create, edit and delete your own cards"),

  // ── Overview ───────────────────────────────────────────────────────
  L("overview.read", "Open the Overview tab"),
  L("overview.cards.read", "The cards on Overview"),
  L("overview.freshness.read", "How current each query is"),
  L("overview.refresh", "Force a query to refresh now"),

  // ── Activity ───────────────────────────────────────────────────────
  L("activity.read.own", "Activity rows where you are the actor"),
  L("activity.read.app.rows", "That somebody else changed something, without naming them"),
  L("activity.read.app.actor", "Who made a change"),
  L("activity.read.github", "Activity rows that came from GitHub"),
  L("activity.pulse.read", "The activity pulse chart"),
  L("activity.undo.repo", "Undo a repository action"),
  L("activity.undo.app", "Undo an app configuration change"),
  L("activity.undo.aws", "Undo an AWS change"),
  L("activity.retry", "Retry a failed action"),
  L("activity.resolution.undo", "Undo a conflict resolution"),
  L("activity.detailedLogging.read", "Whether detailed logging is on"),
  L("activity.detailedLogging.manage", "Turn detailed logging on or off"),

  // ── Alarms ─────────────────────────────────────────────────────────
  L("alarms.org.read", "Organization-wide alarms"),
  L("alarms.org.create", "Create an organization-wide alarm"),
  L("alarms.org.edit", "Edit an organization-wide alarm"),
  L("alarms.org.delete", "Delete an organization-wide alarm"),
  L("alarms.groups.read", "Email groups"),
  L("alarms.groups.manage", "Create and change email groups"),
  L("alarms.groups.test", "Send a test to an email group"),
  L("alarms.teamsFlow.read", "The shared Teams webhook"),
  L("alarms.teamsFlow.manage", "Change the shared Teams webhook"),
  L("alarms.security.read", "Security alert settings"),
  L("alarms.security.manage", "Change security alert settings"),
  L("alarms.feeds.read", "Per-feed notification settings"),
  L("alarms.feeds.manage", "Change per-feed notification settings"),

  // ── AWS ────────────────────────────────────────────────────────────
  L("aws.read", "Open the AWS tab"),
  L("aws.rules.read", "AWS guardrail rules"),
  L("aws.rules.create", "Create a guardrail rule"),
  L("aws.rules.edit", "Edit a guardrail rule"),
  L("aws.rules.delete", "Delete a guardrail rule"),
  L("aws.rules.enforce", "Move a rule from report into enforce mode"),
  L("aws.findings.read", "Guardrail findings"),
  L("aws.sweep.run", "Run a guardrail sweep"),
  L("aws.remediate", "Fix a finding"),
  L("aws.preview", "Preview a remediation"),
  L("aws.exclusions.read", "Guardrail exclusions"),
  L("aws.exclusions.manage", "Create and remove guardrail exclusions"),
  L("aws.accounts.read", "The AWS accounts in scope"),
  L("aws.costs.read", "AWS cost figures"),

  // ── Access ─────────────────────────────────────────────────────────
  L("access.read", "Open the Access tab"),
  L("access.people.read", "Access by person"),
  L("access.teams.read", "Access by team"),
  L("access.repos.read", "Access by repository"),
  L("access.refresh", "Force the access map to recrawl"),

  // ── Vulnerabilities ────────────────────────────────────────────────
  L("deps.read", "Open the Vulnerabilities tab"),
  L("deps.advisories.read", "Dependency advisories"),
  L("deps.age.read", "How out of date dependencies are"),
  L("deps.dependabot.read", "Dependabot state"),
  L("deps.dependabot.manage", "Turn Dependabot on or off for a repository"),
  L("deps.dependabot.bulk", "Bulk Dependabot operations and closing pull requests"),
  L("deps.renovate.read", "Renovate dashboards"),
  L("deps.renovate.manage", "Change the Renovate bot name and tick dashboards"),

  // ── Repos ──────────────────────────────────────────────────────────
  L("repos.read", "Open the Repos tab"),
  L("repos.detail.read", "One repository's detail"),
  L("repos.blastRadius.read", "What depends on a repository"),
  L("repos.query.read", "Saved graph queries"),
  L("repos.query.refresh", "Refresh a saved query"),
  L("repos.graph.rebuild", "Rebuild the whole access graph"),

  // ── Pull requests ──────────────────────────────────────────────────
  L("pulls.read", "Open the Pull requests tab"),
  L("pulls.state.read", "Reminder state"),
  L("pulls.mutes.read", "Which reminders are muted"),
  L("pulls.mute", "Mute a reminder"),
  L("pulls.pause", "Pause reminders for everyone"),
  L("pulls.settings.read", "Reminder settings"),
  L("pulls.settings.manage", "Change reminder settings"),
  L("pulls.run", "Run the reminder pass now"),

  // ── Who knows ──────────────────────────────────────────────────────
  L("expertise.read", "Open the Who knows tab"),
  L("expertise.repo.read", "Who knows a repository"),
  L("expertise.path.read", "Who knows a path"),
  L("expertise.library.read", "Who knows a library"),

  // ── Organization-level reads ───────────────────────────────────────
  L("org.members.read", "The organization's members"),
  L("org.config.read", "Organization configuration"),
  L("org.webhookHealth.read", "Webhook health"),
  L("org.budget.read", "The GitHub API budget"),

  // ── Import and export ──────────────────────────────────────────────
  L("config.export", "Export the configuration bundle"),
  L("config.import", "Import a configuration bundle"),

  // ── Admin ──────────────────────────────────────────────────────────
  L("admin.console.open", "Open the Admin tab"),
  L("admin.people.read", "See who holds what"),
  L("admin.people.assign", "Assign a preset to somebody"),
  L("admin.people.override", "Grant or revoke one permission for one person"),
  L("admin.presets.read", "See the presets"),
  L("admin.presets.create", "Create a preset"),
  L("admin.presets.edit", "Edit a preset"),
  L("admin.presets.delete", "Delete a preset"),
  L("admin.audit.read", "The change history of the permissions file"),
];

export const LEAF_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map(p => p.key));

/** Every branch, derived from the leaves. `alarms.org.create` yields `alarms` and `alarms.org`. */
const BRANCH_KEYS: ReadonlySet<string> = (() => {
  const out = new Set<string>();
  for (const { key } of PERMISSIONS) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
})();

export function isLeaf(key: string): boolean {
  return LEAF_KEYS.has(key);
}

/** A leaf or a branch. Anything else came from a stale file or a typo. */
export function isKnownNode(node: string): boolean {
  return LEAF_KEYS.has(node) || BRANCH_KEYS.has(node);
}

/**
 * Whether `key` is `node` or sits beneath it.
 *
 * On a segment boundary, always. A plain `startsWith` would make `me` match
 * `members.read`, silently granting a tab nobody chose — the kind of bug that
 * only shows up once somebody adds a top-level branch whose name is a prefix
 * of another.
 */
function isUnder(key: string, node: string): boolean {
  return key === node || key.startsWith(node + ".");
}

/** Every leaf `node` stands for. A leaf stands for itself; an unknown node for nothing. */
export function leavesUnder(node: string): string[] {
  return PERMISSIONS.filter(p => isUnder(p.key, node)).map(p => p.key);
}

/**
 * Anything wrong with the list above, as sentences.
 *
 * Exported rather than thrown at import time so the test can name the problem;
 * a module that throws on load fails every suite that touches it with a stack
 * trace instead of a message.
 */
export function vocabularyProblems(): string[] {
  const problems: string[] = [];
  const keys = PERMISSIONS.map(p => p.key);

  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) problems.push(`"${key}" is listed twice`);
    seen.add(key);
  }

  for (const key of keys) {
    for (const other of keys) {
      if (key !== other && isUnder(other, key)) {
        problems.push(`"${key}" is both a permission and the parent of "${other}"`);
      }
    }
  }
  return problems;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissions.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/vocabulary.ts repro-permissions.ts
git commit -m "Permission vocabulary, and the tree its keys already form"
```

---

### Task 2: The file's shapes, and resolving a preset

**Files:**
- Create: `src/permissions/types.ts`
- Create: `src/permissions/presets.ts`
- Modify: `repro-permissions.ts` (append a section)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PermissionEntry { grant?: string[]; revoke?: string[] }`, `Preset extends PermissionEntry { name: string; description?: string; inherits?: string }`, `PersonEntry extends PermissionEntry { id?: number; presets?: string[]; note?: string }`, `TeamEntry extends PermissionEntry { presets?: string[] }`, `PermissionsFile { version: number; presets: Record<string, Preset>; teams: Record<string, TeamEntry>; people: Record<string, PersonEntry> }`, and from `presets.ts`: `Rule { node: string; effect: "grant" | "revoke"; sublayer: number; origin: string }`, `resolvePreset(presets, id, layerLabel): Rule[]`, `presetProblems(presets): string[]`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissions.ts`, immediately **before** the final two lines (`console.log(failures === 0 …)` and `process.exit(…)`):

```ts
console.log("\nresolving a preset");
{
  const presets: Record<string, Preset> = {
    engineer: { name: "Engineer", grant: ["me", "activity.read.own"] },
    lead: { name: "Lead", inherits: "engineer", grant: ["alarms"], revoke: ["alarms.org.delete"] },
    deep4: { name: "D4", inherits: "lead" },
  };

  const engineer = resolvePreset(presets, "engineer", "preset");
  check("a preset yields one rule per entry", engineer.length === 2, engineer);
  check("  carrying the node and the effect",
    engineer[0].node === "me" && engineer[0].effect === "grant", engineer[0]);
  check("  and naming where it came from",
    engineer.every(r => r.origin.includes("Engineer")), engineer.map(r => r.origin));

  const lead = resolvePreset(presets, "lead", "preset");
  check("inherited rules come through", lead.some(r => r.node === "me"), lead);
  check("  along with the child's own", lead.some(r => r.node === "alarms"));
  check("  and the child's revoke", lead.some(r => r.node === "alarms.org.delete" && r.effect === "revoke"));

  /**
   * The child must outrank its parent, or "inherit Engineer, but not this one
   * thing" cannot be written. Sublayer is how that ordering survives into the
   * resolver, which sees a flat list.
   */
  const own = lead.find(r => r.node === "alarms")!;
  const inherited = lead.find(r => r.node === "me")!;
  check("  with the child outranking the parent", own.sublayer > inherited.sublayer,
    { own: own.sublayer, inherited: inherited.sublayer });

  check("an unknown preset resolves to nothing rather than throwing",
    resolvePreset(presets, "no-such-preset", "preset").length === 0);

  // Cycles and runaway chains are schema errors: they fail the file closed
  // rather than looping.
  const cyclic: Record<string, Preset> = {
    a: { name: "A", inherits: "b" },
    b: { name: "B", inherits: "a" },
  };
  check("a cycle is reported", presetProblems(cyclic).some(p => /cycle/i.test(p)),
    presetProblems(cyclic));
  check("  and resolving one does not hang",
    resolvePreset(cyclic, "a", "preset").length === 0);

  const tooDeep: Record<string, Preset> = {
    p1: { name: "1" }, p2: { name: "2", inherits: "p1" }, p3: { name: "3", inherits: "p2" },
    p4: { name: "4", inherits: "p3" }, p5: { name: "5", inherits: "p4" },
    p6: { name: "6", inherits: "p5" },
  };
  check("an inheritance chain deeper than 4 is reported",
    presetProblems(tooDeep).some(p => /deep/i.test(p)), presetProblems(tooDeep));

  check("a preset naming an unknown parent is reported",
    presetProblems({ x: { name: "X", inherits: "ghost" } }).some(p => /ghost/.test(p)));

  check("a healthy set has no problems", presetProblems(presets).length === 0, presetProblems(presets));
}
```

Add to the imports at the top of `repro-permissions.ts`:

```ts
import type { Preset } from "./src/permissions/types";
import { resolvePreset, presetProblems } from "./src/permissions/presets";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissions.ts`
Expected: FAIL — `Cannot find module './src/permissions/types'`

- [ ] **Step 3: Write the types**

Create `src/permissions/types.ts`:

```ts
/**
 * The shapes in `permissions.json`.
 *
 * Deliberately separate from the engine that reads them: these travel to the
 * frontend and into the file on disk, while the engine is internal. A type that
 * is shared by three consumers should not live inside one of them.
 */

/** Grants and revokes. Every string is a node — a leaf or a branch. */
export interface PermissionEntry {
  grant?: string[];
  revoke?: string[];
}

export interface Preset extends PermissionEntry {
  name: string;
  description?: string;
  /** Single parent. Resolved before this preset's own entries, and outranked by them. */
  inherits?: string;
}

export interface PersonEntry extends PermissionEntry {
  /**
   * GitHub's numeric user id. Logins can be renamed, and a renamed login
   * silently orphans an entry; the id never changes, so a mismatch is
   * detectable and can be reported rather than silently resolved.
   */
  id?: number;
  presets?: string[];
  note?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface TeamEntry extends PermissionEntry {
  presets?: string[];
}

export interface PermissionsFile {
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  /** When somebody last acknowledged newly added permissions. */
  reviewedAt?: string;
  presets: Record<string, Preset>;
  /** Keyed by GitHub team slug. */
  teams: Record<string, TeamEntry>;
  /** Keyed by lower-cased GitHub login. */
  people: Record<string, PersonEntry>;
}

/** An empty file. Grants nobody anything, which is the correct default. */
export const EMPTY_FILE: PermissionsFile = {
  version: 1, presets: {}, teams: {}, people: {},
};
```

- [ ] **Step 4: Write the preset resolver**

Create `src/permissions/presets.ts`:

```ts
import type { Preset, PermissionEntry } from "./types";

/**
 * One grant or revoke, flattened out of wherever it was written.
 *
 * The resolver sees only a list of these, which is what lets team entries,
 * preset entries and a person's own entries be compared by one rule instead of
 * three.
 */
export interface Rule {
  /** A node: a leaf, or a branch standing for every leaf beneath it. */
  node: string;
  effect: "grant" | "revoke";
  /**
   * Ordering *within* a layer, used only for preset inheritance: a child's own
   * entries outrank the parent's, so "inherit Engineer, but not that one thing"
   * is writable. Higher wins.
   */
  sublayer: number;
  /** Shown in the admin UI: "from Engineer", "granted here". Never used to decide. */
  origin: string;
}

/** How deep an `inherits` chain may go before it is a mistake rather than a design. */
export const MAX_INHERIT_DEPTH = 4;

function rulesOf(entry: PermissionEntry, sublayer: number, origin: string): Rule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, sublayer, origin })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, sublayer, origin })),
  ];
}

/**
 * A preset and everything it inherits, flattened.
 *
 * Walks up to the root first so that the deepest ancestor gets the lowest
 * sublayer, then the chain back down raises it — the preset asked for always
 * ends up highest.
 *
 * An unknown id, a cycle or an over-deep chain all resolve to nothing rather
 * than throwing. The file is somebody's data; `presetProblems` reports what is
 * wrong with it, and the caller fails it closed. A throw here would take down
 * every request instead.
 */
export function resolvePreset(
  presets: Record<string, Preset>, id: string, layerLabel: string,
): Rule[] {
  const chain: string[] = [];
  let cursor: string | undefined = id;
  const seen = new Set<string>();

  while (cursor) {
    if (seen.has(cursor)) return [];              // cycle
    if (chain.length >= MAX_INHERIT_DEPTH + 1) return [];  // runaway
    const preset: Preset | undefined = presets[cursor];
    if (!preset) return chain.length === 0 ? [] : finish(chain, presets, layerLabel);
    seen.add(cursor);
    chain.push(cursor);
    cursor = preset.inherits;
  }
  return finish(chain, presets, layerLabel);
}

/** `chain` is child-first; sublayer counts up so the child ends highest. */
function finish(chain: string[], presets: Record<string, Preset>, layerLabel: string): Rule[] {
  const out: Rule[] = [];
  const deepestFirst = [...chain].reverse();
  deepestFirst.forEach((presetId, index) => {
    const preset = presets[presetId];
    if (!preset) return;
    out.push(...rulesOf(preset, index, `${layerLabel} ${preset.name}`));
  });
  return out;
}

/**
 * Everything wrong with a set of presets, as sentences.
 *
 * Reported rather than thrown for the same reason as the vocabulary: the caller
 * decides what a broken file means, and it means fail closed.
 */
export function presetProblems(presets: Record<string, Preset>): string[] {
  const problems: string[] = [];

  for (const [id, preset] of Object.entries(presets)) {
    if (!preset.name) problems.push(`preset "${id}" has no name`);
    if (!preset.inherits) continue;

    if (!presets[preset.inherits]) {
      problems.push(`preset "${id}" inherits "${preset.inherits}", which does not exist`);
      continue;
    }

    const seen = new Set<string>([id]);
    let cursor: string | undefined = preset.inherits;
    let depth = 1;
    while (cursor) {
      if (seen.has(cursor)) { problems.push(`preset "${id}" is in an inheritance cycle`); break; }
      if (depth > MAX_INHERIT_DEPTH) {
        problems.push(`preset "${id}" inherits more than ${MAX_INHERIT_DEPTH} deep`);
        break;
      }
      seen.add(cursor);
      cursor = presets[cursor]?.inherits;
      depth++;
    }
  }
  return problems;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx tsx repro-permissions.ts`
Expected: `ALL PASS`

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/types.ts src/permissions/presets.ts repro-permissions.ts
git commit -m "Permissions file shapes, and preset inheritance that cannot loop"
```

---

### Task 3: Collecting rules from the three layers

**Files:**
- Create: `src/permissions/evaluate.ts`
- Modify: `repro-permissions.ts` (append a section)

**Interfaces:**
- Consumes: `Rule`, `resolvePreset` (Task 2); `PermissionsFile`, `PersonEntry` (Task 2).
- Produces: `LayeredRule extends Rule { layer: number }`, `LAYER = { team: 0, preset: 1, person: 2 }`, `collectRules(file: PermissionsFile, login: string, teamSlugs: string[]): LayeredRule[]`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissions.ts`, before the final two lines:

```ts
console.log("\ncollecting rules from the three layers");
{
  const file: PermissionsFile = {
    version: 1,
    presets: {
      engineer: { name: "Engineer", grant: ["me"] },
      lead: { name: "Lead", inherits: "engineer", grant: ["alarms"] },
    },
    teams: {
      "platform": { presets: ["engineer"], grant: ["repos.read"] },
      "contractors": { revoke: ["access"] },
    },
    people: {
      "some-login": { presets: ["lead"], grant: ["config.export"], revoke: ["alarms.org.delete"] },
    },
  };

  const rules = collectRules(file, "some-login", ["platform", "contractors"]);

  check("a person's own entries are collected",
    rules.some(r => r.node === "config.export" && r.layer === LAYER.person), rules);
  check("  their preset's, at a lower layer",
    rules.some(r => r.node === "alarms" && r.layer === LAYER.preset));
  check("  what that preset inherits, same layer",
    rules.some(r => r.node === "me" && r.layer === LAYER.preset));
  check("  and their teams', lower still",
    rules.some(r => r.node === "repos.read" && r.layer === LAYER.team));
  check("  including a team's preset",
    rules.some(r => r.node === "me" && r.layer === LAYER.team));
  check("  and a team's revoke",
    rules.some(r => r.node === "access" && r.effect === "revoke" && r.layer === LAYER.team));

  // The login is the key, and GitHub logins are not case-sensitive in practice.
  check("the login is matched case-insensitively",
    collectRules(file, "SOME-LOGIN", []).some(r => r.node === "config.export"));

  check("somebody with no entry and no teams gets no rules at all",
    collectRules(file, "stranger", []).length === 0);

  // A team the file does not mention contributes nothing, rather than failing.
  check("a team with no entry in the file contributes nothing",
    collectRules(file, "stranger", ["some-other-team"]).length === 0);

  check("every rule says where it came from",
    rules.every(r => r.origin.length > 0), rules.filter(r => !r.origin));
}
```

Add to the imports at the top:

```ts
import type { PermissionsFile } from "./src/permissions/types";
import { collectRules, LAYER } from "./src/permissions/evaluate";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissions.ts`
Expected: FAIL — `Cannot find module './src/permissions/evaluate'`

- [ ] **Step 3: Write the collector**

Create `src/permissions/evaluate.ts`:

```ts
import type { PermissionsFile, PermissionEntry } from "./types";
import { resolvePreset, type Rule } from "./presets";

/**
 * Where a rule was written, in increasing authority.
 *
 * Teams are lowest because membership lives on GitHub and changes without
 * anybody editing this file — so it is the layer a person should be able to
 * override, not the other way round.
 */
export const LAYER = { team: 0, preset: 1, person: 2 } as const;

export interface LayeredRule extends Rule {
  layer: number;
}

function ownRules(entry: PermissionEntry, layer: number, origin: string): LayeredRule[] {
  return [
    ...(entry.grant ?? []).map(node => ({ node, effect: "grant" as const, sublayer: 99, origin, layer })),
    ...(entry.revoke ?? []).map(node => ({ node, effect: "revoke" as const, sublayer: 99, origin, layer })),
  ];
}

/**
 * Every rule that could bear on this person, flattened across the three layers.
 *
 * Order does not matter here — the resolver sorts — so this is a plain
 * concatenation. `sublayer: 99` on direct entries puts them above anything
 * inherited within the same layer, which is what "my own grant beats my
 * preset's" means when both sit at the same depth.
 */
export function collectRules(
  file: PermissionsFile, login: string, teamSlugs: string[],
): LayeredRule[] {
  const out: LayeredRule[] = [];
  const key = login.toLowerCase();

  for (const slug of teamSlugs) {
    const team = file.teams?.[slug];
    if (!team) continue;
    for (const presetId of team.presets ?? []) {
      out.push(...resolvePreset(file.presets ?? {}, presetId, `team ${slug} via`)
        .map(r => ({ ...r, layer: LAYER.team })));
    }
    out.push(...ownRules(team, LAYER.team, `team ${slug}`));
  }

  const person = file.people?.[key];
  if (!person) return out;

  for (const presetId of person.presets ?? []) {
    out.push(...resolvePreset(file.presets ?? {}, presetId, "preset")
      .map(r => ({ ...r, layer: LAYER.preset })));
  }
  out.push(...ownRules(person, LAYER.person, "set on this person"));

  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissions.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/evaluate.ts repro-permissions.ts
git commit -m "Collect permission rules across team, preset and person"
```

---

### Task 4: Resolution — longest prefix wins

**Files:**
- Modify: `src/permissions/evaluate.ts`
- Modify: `repro-permissions.ts` (append a section)

**Interfaces:**
- Consumes: `collectRules`, `LayeredRule`, `LAYER` (Task 3); `leavesUnder`, `PERMISSIONS` (Task 1).
- Produces: `Decision { held: boolean; rule: LayeredRule | null }`, `decideLeaf(leaf: string, rules: LayeredRule[]): Decision`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissions.ts`, before the final two lines:

```ts
console.log("\nresolution: the longest match decides");
{
  const r = (node: string, effect: "grant" | "revoke", layer: number, sublayer = 99): LayeredRule =>
    ({ node, effect, layer, sublayer, origin: "test" });

  check("a leaf matched by nothing is denied",
    decideLeaf("alarms.org.create", []).held === false);

  check("a branch grant reaches the leaf",
    decideLeaf("alarms.org.create", [r("alarms", "grant", LAYER.person)]).held === true);

  /**
   * "All alarms except deleting one." The blanket rule this replaces —
   * union the grants, then subtract the revokes — handles this correctly and
   * the next case wrongly.
   */
  check("a deeper revoke beats a shallower grant",
    decideLeaf("alarms.org.delete",
      [r("alarms", "grant", LAYER.person), r("alarms.org.delete", "revoke", LAYER.person)],
    ).held === false);

  /**
   * "No AWS at all, except seeing findings." Under subtract-last this silently
   * yields nothing and the person who wrote it cannot tell from the file that
   * it did not work.
   */
  check("a deeper grant beats a shallower revoke",
    decideLeaf("aws.findings.read",
      [r("aws", "revoke", LAYER.person), r("aws.findings.read", "grant", LAYER.person)],
    ).held === true);

  check("  and the shallower revoke still holds elsewhere",
    decideLeaf("aws.rules.delete",
      [r("aws", "revoke", LAYER.person), r("aws.findings.read", "grant", LAYER.person)],
    ).held === false);

  // Layer only breaks ties at equal depth. A longer team rule beats a shorter
  // personal one, because specificity is the stronger signal.
  check("at equal depth, a person beats their preset",
    decideLeaf("config.export",
      [r("config.export", "revoke", LAYER.preset), r("config.export", "grant", LAYER.person)],
    ).held === true);

  check("at equal depth, a preset beats a team",
    decideLeaf("config.export",
      [r("config.export", "revoke", LAYER.team), r("config.export", "grant", LAYER.preset)],
    ).held === true);

  check("but a longer team rule beats a shorter personal one",
    decideLeaf("aws.rules.delete",
      [r("aws", "grant", LAYER.person), r("aws.rules.delete", "revoke", LAYER.team)],
    ).held === false);

  // Two teams disagreeing is a real state, and the safe answer is no.
  check("at equal depth and layer, revoke wins",
    decideLeaf("access.read",
      [r("access.read", "grant", LAYER.team), r("access.read", "revoke", LAYER.team)],
    ).held === false);

  // Within a preset chain, the child outranks what it inherits.
  check("within a layer, a higher sublayer wins",
    decideLeaf("me.work.read",
      [r("me.work.read", "grant", LAYER.preset, 0), r("me.work.read", "revoke", LAYER.preset, 1)],
    ).held === false);

  check("the deciding rule is reported, for the admin screen",
    decideLeaf("alarms.org.create", [r("alarms", "grant", LAYER.person)]).rule?.node === "alarms");

  // A branch that no longer exists must not match anything, or a renamed
  // branch silently keeps granting.
  check("a rule naming an unknown node decides nothing",
    decideLeaf("alarms.org.create", [r("nonsense", "grant", LAYER.person)]).held === false);

  // Segment boundaries again, this time in the resolver.
  check("a rule does not match a leaf that merely starts with its text",
    decideLeaf("activity.read.github",
      [r("activity.read.app", "grant", LAYER.person)],
    ).held === false);
}
```

Add `LayeredRule` and `decideLeaf` to the existing `evaluate` import at the top:

```ts
import { collectRules, LAYER, decideLeaf, type LayeredRule } from "./src/permissions/evaluate";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissions.ts`
Expected: FAIL — `decideLeaf is not a function`

- [ ] **Step 3: Write the resolver**

First add to the imports **at the top** of `src/permissions/evaluate.ts` — an
`import` appended below the code is hoisted and works, but nobody reading the
file will look for it there:

```ts
import { isKnownNode } from "./vocabulary";
```

Then append to the end of the same file:

```ts
export interface Decision {
  held: boolean;
  /** The rule that decided it, for the admin screen. Null when nothing matched. */
  rule: LayeredRule | null;
}

/** On a segment boundary: `me` must not match `members.read`. */
function covers(node: string, leaf: string): boolean {
  return leaf === node || leaf.startsWith(node + ".");
}

const depthOf = (node: string) => node.split(".").length;

/**
 * Whether this person holds one leaf, and which rule said so.
 *
 * **The longest match decides.** Depth first, because specificity is the
 * strongest signal of intent: somebody who wrote `aws.findings.read` meant that
 * leaf more precisely than whoever wrote `aws`. Only at equal depth does it
 * matter who wrote it — person over preset over team — and only at equal depth
 * *and* layer does revoke win over grant, which is the safe answer when two
 * teams disagree.
 *
 * The alternative, union-the-grants-then-subtract-the-revokes, cannot express
 * "none of AWS except the findings": the shallow revoke eats the deep grant and
 * the file gives no sign that it did.
 *
 * A rule naming a node the vocabulary does not have decides nothing. That keeps
 * a renamed or deleted branch from silently continuing to grant, and it is why
 * an unknown node is tolerated at read time rather than failing the file.
 */
export function decideLeaf(leaf: string, rules: LayeredRule[]): Decision {
  let best: LayeredRule | null = null;

  for (const rule of rules) {
    if (!isKnownNode(rule.node)) continue;
    if (!covers(rule.node, leaf)) continue;
    if (!best) { best = rule; continue; }

    const a = [depthOf(rule.node), rule.layer, rule.sublayer, rule.effect === "revoke" ? 1 : 0];
    const b = [depthOf(best.node), best.layer, best.sublayer, best.effect === "revoke" ? 1 : 0];
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      if (a[i] > b[i]) best = rule;
      break;
    }
  }

  return { held: best?.effect === "grant", rule: best };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissions.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/permissions/evaluate.ts repro-permissions.ts
git commit -m "Resolve permissions by longest prefix, then layer, then revoke"
```

---

### Task 5: The entry point — owners, and explaining an answer

**Files:**
- Modify: `src/permissions/evaluate.ts`
- Modify: `repro-permissions.ts` (append a section)

**Interfaces:**
- Consumes: everything above.
- Produces: `Subject { login: string; teamSlugs: string[]; isOrgOwner: boolean }`, `PermissionSet { has(leaf: string): boolean; held: string[]; explain(leaf: string): Explanation }`, `Explanation { held: boolean; reason: "owner" | "granted" | "revoked" | "not granted"; origin: string | null }`, `permissionsFor(file: PermissionsFile, subject: Subject): PermissionSet`.

- [ ] **Step 1: Write the failing test**

Append to `repro-permissions.ts`, before the final two lines:

```ts
console.log("\nthe answer, and why");
{
  const file: PermissionsFile = {
    version: 1,
    presets: { engineer: { name: "Engineer", grant: ["me"] } },
    teams: {},
    people: {
      "granted-person": { presets: ["engineer"], grant: ["alarms"], revoke: ["alarms.org.delete"] },
    },
  };
  const plain = { login: "stranger", teamSlugs: [], isOrgOwner: false };

  const nobody = permissionsFor(file, plain);
  check("somebody with no entry holds nothing at all",
    nobody.held.length === 0, nobody.held.slice(0, 5));
  check("  not even their own screens",
    !nobody.has("me.work.read") && !nobody.has("me.alerts.read"));
  check("  and not reading, either",
    !nobody.has("activity.read.own") && !nobody.has("repos.read"));

  /**
   * Owners are exempt from every check, deliberately: otherwise an empty or
   * broken file locks everybody out of the screen that would fix it. This is
   * the same rule the old team check had, kept and made visible.
   */
  const owner = permissionsFor(file, { ...plain, isOrgOwner: true });
  check("an organization owner holds everything",
    owner.held.length === PERMISSIONS.length, owner.held.length);
  check("  and is told that is why",
    owner.explain("aws.rules.delete").reason === "owner");

  const person = permissionsFor(file, { ...plain, login: "granted-person" });
  check("a preset's branch grant reaches its leaves", person.has("me.work.read"));
  check("  a direct branch grant too", person.has("alarms.org.create"));
  check("  and a deeper revoke still bites", !person.has("alarms.org.delete"));
  check("  while nothing else is granted", !person.has("aws.rules.read"));

  const why = person.explain("alarms.org.delete");
  check("a refusal names the rule that caused it",
    why.held === false && why.reason === "revoked" && why.origin === "set on this person", why);

  const from = person.explain("me.work.read");
  check("  and a grant names where it came from",
    from.held === true && from.reason === "granted" && from.origin === "preset Engineer", from);

  const never = person.explain("aws.costs.read");
  check("  and something simply not granted says so",
    never.held === false && never.reason === "not granted" && never.origin === null, never);

  check("held is sorted, so two runs give the same file",
    person.held.join() === [...person.held].sort().join());

  // A file whose presets are broken must not grant anything by accident.
  const broken: PermissionsFile = {
    version: 1,
    presets: { a: { name: "A", inherits: "b" }, b: { name: "B", inherits: "a", grant: ["aws"] } },
    teams: {},
    people: { "x": { presets: ["a"] } },
  };
  check("a cyclic preset grants nothing rather than looping",
    permissionsFor(broken, { ...plain, login: "x" }).held.length === 0);
}
```

Extend the existing `evaluate` import at the top of `repro-permissions.ts` to
its final form. `PERMISSIONS` is already imported from `vocabulary` in Task 1:

```ts
import {
  collectRules, LAYER, decideLeaf, permissionsFor, type LayeredRule,
} from "./src/permissions/evaluate";
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx repro-permissions.ts`
Expected: FAIL — `permissionsFor is not a function`

- [ ] **Step 3: Write the entry point**

First extend the vocabulary import **at the top** of
`src/permissions/evaluate.ts`, which Task 4 added — one import line per module,
not two:

```ts
import { isKnownNode, PERMISSIONS } from "./vocabulary";
```

Then append to the end of the same file:

```ts
export interface Subject {
  login: string;
  /** GitHub team slugs this person is in. Read by the caller; this is pure. */
  teamSlugs: string[];
  /**
   * Organization owners are exempt from every check.
   *
   * Otherwise an empty file, a broken file, or an administrator who removed
   * their own access locks everybody out of the one screen that could fix it.
   * The old team check had the same exemption; this keeps it and makes it
   * visible in `explain`, because access nobody can account for reads as a bug.
   */
  isOrgOwner: boolean;
}

export interface Explanation {
  held: boolean;
  reason: "owner" | "granted" | "revoked" | "not granted";
  /** "preset Engineer", "team platform", "set on this person". Null when nothing matched. */
  origin: string | null;
}

export interface PermissionSet {
  has(leaf: string): boolean;
  /** Every leaf held, sorted. */
  held: string[];
  explain(leaf: string): Explanation;
}

/**
 * What this person may do.
 *
 * Computed once over the whole vocabulary rather than lazily per question: the
 * vocabulary is small, the admin screen needs every answer at once anyway, and
 * a set that cannot change under a request is one fewer thing to reason about.
 */
export function permissionsFor(file: PermissionsFile, subject: Subject): PermissionSet {
  if (subject.isOrgOwner) {
    const all = PERMISSIONS.map(p => p.key).sort();
    return {
      has: () => true,
      held: all,
      explain: () => ({ held: true, reason: "owner", origin: "organization owner" }),
    };
  }

  const rules = collectRules(file, subject.login, subject.teamSlugs);
  const decisions = new Map<string, Decision>();
  for (const { key } of PERMISSIONS) decisions.set(key, decideLeaf(key, rules));

  const held = [...decisions.entries()]
    .filter(([, d]) => d.held).map(([key]) => key).sort();

  return {
    has: (leaf: string) => decisions.get(leaf)?.held === true,
    held,
    explain(leaf: string): Explanation {
      const decision = decisions.get(leaf);
      if (!decision?.rule) return { held: false, reason: "not granted", origin: null };
      return {
        held: decision.held,
        reason: decision.held ? "granted" : "revoked",
        origin: decision.rule.origin,
      };
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx repro-permissions.ts`
Expected: `ALL PASS`

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 6: Run the whole backend suite, to be sure nothing else moved**

Run:
```bash
bad=0; for f in repro-*.ts; do out=$(npx tsx "$f" 2>&1); \
  if printf '%s\n' "$out" | grep -qE '^[[:space:]]*(FAIL|✗)|did not hold'; then \
  bad=$((bad+1)); echo "=== $f"; fi; done; echo "failing=$bad"
```
Expected: `failing=0`

- [ ] **Step 7: Commit**

```bash
git add src/permissions/evaluate.ts repro-permissions.ts
git commit -m "Answer what one person may do, and why"
```

---

## What this stage deliberately does not do

Named so the next plan starts from a known edge, and so a reviewer does not
look for them:

- **No I/O.** Nothing reads GitHub, DynamoDB or disk. `permissionsFor` takes a
  file it is handed.
- **No enforcement.** No middleware, no route changes. Nothing in the running
  app calls any of this yet.
- **No schema validation of an untrusted file.** `presetProblems` and
  `vocabularyProblems` report what is wrong; deciding that a broken file means
  *fail closed* is stage 2's job, with the parse and the fetch around it.
- **No migration, no admin UI.** Stages 3 and 4.

## Next plans

- **Stage 2 — storage:** fetch and write `permissions.json` with the App token,
  `sha`-based optimistic concurrency, schema validation, the 60-second cache,
  team-membership reads, and the failure modes in the spec's table.
- **Stage 3 — enforcement:** `requirePermission` middleware on ~155 endpoints
  behind `PERMISSIONS_ENABLED`, plus the build-time completeness assertions in
  `repro-permissiongates.ts`.
- **Stage 4 — the Admin tab:** the four screens, the migration generator and
  the dry-run diff, then the flip.
