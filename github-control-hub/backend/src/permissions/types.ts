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
