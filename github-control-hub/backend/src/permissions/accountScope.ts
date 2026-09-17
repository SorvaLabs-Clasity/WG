import { PERMISSIONS, isUnder, type PermissionLeaf } from "./vocabulary";

/**
 * Per-account AWS permissions, as a branch of the same tree.
 *
 * `aws.rules.edit` means "in every account". `aws.account.<id>.rules.edit`
 * means "in that one". Holding **either** permits the action there, which is
 * what makes this purely additive: every file, preset and grant written before
 * accounts existed keeps its exact meaning, and there is no migration that
 * could silently narrow somebody.
 *
 * The account id is a path segment rather than a separate `scope` field so the
 * engine needs no new concept: prefix grants, revokes at any depth,
 * longest-prefix resolution and the tree UI all work on it unchanged.
 * `aws.account` grants every account including ones added later; naming one
 * account does not.
 */

/** The `aws.*` suffixes that mean something in a single account. */
const SCOPED_AWS_SUFFIXES = [
  "rules.read", "rules.create", "rules.edit", "rules.delete", "rules.enforce",
  "findings.read", "sweep.run", "remediate", "preview",
  "exclusions.read", "exclusions.manage", "costs.read",
] as const;

/**
 * Activity is scoped too, because an AWS row belongs to an account.
 *
 * `activity.read.aws` and `activity.undo.aws` are global forms meaning every
 * account; the scoped forms limit them to one. Detailed logging is per-account
 * by nature — CloudTrail is configured in the account, not across the estate —
 * so it was always really an account-level switch wearing a global name.
 */
const SCOPED_ACTIVITY_SUFFIXES = [
  "activity.read.aws", "activity.undo.aws",
  "activity.detailedLogging.read", "activity.detailedLogging.manage",
] as const;

const LABELS: Record<string, string> = {
  "rules.read": "Guardrail rules",
  "rules.create": "Create a guardrail rule",
  "rules.edit": "Edit a guardrail rule",
  "rules.delete": "Delete a guardrail rule",
  "rules.enforce": "Move a rule from report into enforce mode",
  "findings.read": "Guardrail findings",
  "sweep.run": "Run a guardrail sweep",
  "remediate": "Fix a finding",
  "preview": "Preview a remediation",
  "exclusions.read": "Guardrail exclusions",
  "exclusions.manage": "Create and remove guardrail exclusions",
  "costs.read": "Cost figures",
  "activity.read.aws": "Activity rows from this account",
  "activity.undo.aws": "Undo a change made in this account",
  "activity.detailedLogging.read": "Whether detailed logging is on",
  "activity.detailedLogging.manage": "Turn detailed logging on or off",
};

/** Every suffix that gets a per-account form. */
export const SCOPED_SUFFIXES: readonly string[] =
  [...SCOPED_AWS_SUFFIXES, ...SCOPED_ACTIVITY_SUFFIXES];

/**
 * A twelve-digit AWS account id, and nothing else.
 *
 * The id becomes a path segment, so a value containing a dot would invent
 * branches — `aws.account.12.34.remediate` reads as an account `12` with a
 * sub-account `34`, and a grant of `aws.account.12` would then cover it. An id
 * that does not match is left out of the vocabulary entirely rather than
 * sanitised into something that looks like an account but is not one.
 */
export function isAccountId(id: string): boolean {
  return /^[0-9]{12}$/.test(id);
}

/** `aws.account.<id>` — the node that stands for everything in one account. */
export function accountNode(accountId: string): string {
  return `aws.account.${accountId}`;
}

/** The scoped key for one action in one account. */
export function scopedKey(accountId: string, suffix: string): string {
  return `${accountNode(accountId)}.${suffix}`;
}

/**
 * The global key a scoped suffix corresponds to.
 *
 * `rules.edit` is `aws.rules.edit`; the activity suffixes are already whole
 * keys and stand alone. This is the map that lets a global grant answer for
 * every account without the file having to name them.
 */
export function globalKeyFor(suffix: string): string {
  return suffix.startsWith("activity.") ? suffix : `aws.${suffix}`;
}

/** The leaves that exist because these accounts are configured. */
export function accountLeaves(accountIds: readonly string[]): PermissionLeaf[] {
  const out: PermissionLeaf[] = [];
  for (const id of accountIds) {
    if (!isAccountId(id)) continue;
    for (const suffix of SCOPED_SUFFIXES) {
      out.push({ key: scopedKey(id, suffix), label: LABELS[suffix] ?? suffix, addedIn: 4 });
    }
  }
  return out;
}

/** The whole vocabulary: the fixed leaves, plus one branch per configured account. */
export function vocabularyFor(accountIds: readonly string[]): PermissionLeaf[] {
  return [...PERMISSIONS, ...accountLeaves(accountIds)];
}

/**
 * Whether `held` permits `suffix` in `accountId`.
 *
 * The global form answers for every account, so it is checked first and the
 * scoped form is the narrowing. A caller with `aws.remediate` and a revoke of
 * `aws.account.<prod>` is refused in prod by the engine's own longest-prefix
 * rule — this function asks the question, it does not re-implement the answer.
 */
export function permitsInAccount(
  has: (key: string) => boolean, accountId: string, suffix: string,
): boolean {
  return has(scopedKey(accountId, suffix)) || has(globalKeyFor(suffix));
}

/** Whether a node names one account's subtree, and which. */
export function accountOf(node: string): string | null {
  if (!isUnder(node, "aws.account")) return null;
  const id = node.split(".")[2];
  return id && isAccountId(id) ? id : null;
}

/**
 * Which accounts are configured, as the engine currently believes.
 *
 * The vocabulary depends on this, and the vocabulary is consulted on every
 * permission decision — so it is a registry rather than a parameter threaded
 * through thirty call sites, refreshed from `resolveAccounts()` rather than
 * read from it on each question.
 *
 * Empty until something sets it, and empty is the safe state: no account
 * leaves exist, so no scoped grant resolves and every AWS decision falls back
 * to the global keys, which is exactly the behaviour before accounts were
 * scoped at all. An install that never refreshes this is not broken, only
 * un-scoped.
 */
let configured: readonly string[] = [];

export function setConfiguredAccounts(ids: readonly string[]): void {
  configured = [...new Set(ids.filter(isAccountId))].sort();
}

export function configuredAccounts(): readonly string[] {
  return configured;
}

/** The vocabulary as it stands: the fixed leaves plus the configured accounts. */
export function currentVocabulary(): PermissionLeaf[] {
  return vocabularyFor(configured);
}

const branchesOf = (leaves: PermissionLeaf[]): Set<string> => {
  const out = new Set<string>();
  for (const { key } of leaves) {
    const parts = key.split(".");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("."));
  }
  return out;
};

/**
 * A leaf or a branch, accounts included.
 *
 * `aws.account` is a known branch even with no accounts configured, so a grant
 * naming it is not reported as a typo on an install whose account list has not
 * loaded yet — it grants nothing there, which is different from being wrong.
 */
export function isKnownNodeNow(node: string): boolean {
  if (node === "aws.account") return true;
  const leaves = currentVocabulary();
  if (leaves.some(l => l.key === node)) return true;
  return branchesOf(leaves).has(node);
}

/** Every leaf `node` stands for, accounts included. */
export function leavesUnderNow(node: string): string[] {
  return currentVocabulary().filter(l => isUnder(l.key, node)).map(l => l.key);
}


/**
 * The account this install *is*.
 *
 * Permissions are per account, and a request arriving at this process concerns
 * the account this process runs in — so every gate resolves against this one.
 * The admin console edits entries for every declared account, because the file
 * is shared; only this account's entries decide anything here.
 *
 * Undefined until `resolveAccounts` has run, and undefined is meaningful: it
 * means "accounts are not in play", and evaluation falls back to the entry's
 * top-level fields, which is every file written before accounts existed.
 */
let installAccount: string | undefined;

export function setInstallAccount(accountId: string | undefined): void {
  installAccount = accountId && isAccountId(accountId) ? accountId : undefined;
}

export function installAccountId(): string | undefined {
  return installAccount;
}
