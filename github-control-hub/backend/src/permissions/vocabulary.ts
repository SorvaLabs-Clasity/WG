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
export const VOCABULARY_VERSION = 4;

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
  /**
   * AWS rows, as a thing in their own right.
   *
   * They used to be reachable only through `activity.read.app.rows`, which is
   * every row somebody else made whatever it touched. That is one permission
   * for two questions, and it left no key to scope per account.
   *
   * Additive: holding either this or `activity.read.app.rows` shows an AWS
   * row, so nothing anybody holds today is narrowed by its arrival.
   */
  L("activity.read.aws", "Activity rows from AWS accounts", 4),
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
  /**
   * "Feeds" is what the code calls them and it tells a reader nothing. There
   * are exactly two, both on the Vulnerabilities tab, and naming them is the
   * difference between a checkbox somebody can decide about and one they tick
   * to find out.
   */
  L("alarms.feeds.read", "Renovate and Dependabot notification settings"),
  L("alarms.feeds.manage", "Change how Renovate and Dependabot notify"),

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
  /**
   * Not "preview a remediation" — it is a dry run of the whole evaluation.
   * Every rule is checked against real resources, every violation is counted,
   * and the branch that would fix anything is unreachable, so a rule sitting
   * in enforce mode does nothing during a preview. That is the useful half to
   * grant on production without granting the two above it.
   */
  L("aws.preview", "Check every rule without changing anything"),
  L("aws.exclusions.read", "Guardrail exclusions"),
  L("aws.exclusions.manage", "Create and remove guardrail exclusions"),
  /**
   * A list, not a key. It answers "which accounts and regions do the
   * guardrails cover", and carries account ids, names, regions and whether
   * each is enabled — no credentials, and no access to any of them. Somebody
   * holding this can see the estate's shape; acting in it is every other
   * permission here.
   */
  L("aws.accounts.read", "Which AWS accounts and regions guardrails cover"),
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
  //
  // Missing from v1 and v2: `branches.ts` and `protection.ts` change what a
  // repository *is* — a deleted branch, a stripped protection rule — and the
  // only key that came close was `repos.detail.read`, which means "look at one
  // repository". Reading a repository's detail is not consent to rewrite its
  // refs, so the destructive half gets keys of its own rather than borrowing
  // the read one.
  L("repos.branches.manage", "Create, delete or rename a branch", 3),
  L("repos.protection.manage", "Change branch protection or rulesets", 3),

  // ── Scanners ───────────────────────────────────────────────────────
  //
  // Missing from v1: scanners.ts already existed and was written against a
  // "scanners.*" branch that was never added here, so every route in it was
  // unnameable without inventing a key. Added now, in v2, rather than left for
  // a route to invent one, which is exactly what this vocabulary exists to
  // prevent.
  L("scanners.read", "Scanner definitions and their past results", 2),
  L("scanners.manage", "Create, edit and delete scanners", 2),
  L("scanners.run", "Run a scanner now", 2),

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

  // ── The shared dashboard ───────────────────────────────────────────
  //
  // Separate from `me.widgets.*`, which is somebody's own board. There is one
  // Overview dashboard and everybody reads it, so changing it is a change to
  // shared configuration — `overview.cards.read`, which merely means seeing
  // those cards, said nothing about that and should never have gated a write.
  L("widgets.org.create", "Add a card to the shared dashboard", 3),
  L("widgets.org.edit", "Change a card on the shared dashboard", 3),
  L("widgets.org.delete", "Remove a card from the shared dashboard", 3),

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
 *
 * Exported because the resolver asks the same question of a rule's node, and
 * two copies of a security-critical prefix rule are two things to keep in step.
 */
export function isUnder(key: string, node: string): boolean {
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
