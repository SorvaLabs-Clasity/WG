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
  /**
   * What this person holds, per account, keyed by account id.
   *
   * An account with no entry here grants them nothing there — deny by default
   * applied to a dimension rather than an exception to it. That is why a newly
   * declared account starts empty and why the admin screen can copy one
   * account's entry onto others.
   *
   * The `presets`/`grant`/`revoke` above this are the pre-account shape and are
   * still honoured: an install that has declared no accounts reads them, and a
   * file written before accounts existed keeps working unchanged.
   */
  accounts?: Record<string, AccountEntry>;
}

export interface TeamEntry extends PermissionEntry {
  presets?: string[];
  /** As `PersonEntry.accounts`: what this team confers in one account. */
  accounts?: Record<string, AccountEntry>;
}

/**
 * What somebody holds **in one account**.
 *
 * The account is a dimension over the whole vocabulary rather than a branch
 * inside part of it: an account is a configured environment, some with GitHub
 * and some without, and each has its own tabs. "Read Activity in sandbox but
 * not in production" is a sentence the key path could never express and this
 * one states directly.
 *
 * Presets are global *definitions* — a named bundle is the same bundle
 * wherever it is applied. What varies per account is who holds which bundle,
 * and whatever is set on them directly on top of it.
 */
export interface AccountEntry {
  presets?: string[];
  grant?: string[];
  revoke?: string[];
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
  /**
   * AWS accounts this organization wants to scope permissions by.
   *
   * Declaring an account here is not the same as the app being able to reach
   * it: credentials are a separate, later problem. It is a statement that this
   * account exists and is worth talking about, which is all the permission
   * tree needs in order to offer `aws.account.<id>.*` for it.
   *
   * Kept in this file rather than in a database because it is the same kind of
   * thing as everything else here — an organization-wide decision somebody
   * should be able to read, review and revert in git.
   */
  awsAccounts?: AwsAccountEntry[];
}

export interface AwsAccountEntry {
  /** The twelve-digit account id. Becomes a segment of every scoped key. */
  accountId: string;
  /** What people call it: "prod", "sandbox". Shown instead of the digits. */
  name: string;
  /** Free text, for whoever finds this in six months. */
  note?: string;
}

/**
 * An empty file. Grants nobody anything, which is the correct default.
 *
 * A function rather than a shared constant: stage 2 returns this on every read
 * failure, so a single consumer that pushed one preset into it would widen
 * access for every request the process served afterwards. A fresh object per
 * call cannot be poisoned.
 */
export function emptyFile(): PermissionsFile {
  return { version: 1, presets: {}, teams: {}, people: {} };
}
