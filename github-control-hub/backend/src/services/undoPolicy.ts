import type { ActivityEntry } from "./activityService";
import type { RepoLevel } from "../github/permissions";

/**
 * What may be undone, and why anything else may not.
 *
 * Undo used to be permissive by omission: an entry with no undo payload, or one
 * naming an operation nothing implements, fell through to a no-op that still
 * reported success and still marked the row undone. An audit log that records
 * an undo which never happened is worse than one that refuses.
 */

/**
 * Records of things that happened to code. The Control Hub watches these; it
 * did not do them.
 *
 * Rewriting history is a decision for whoever owns the branch, taken in git
 * where they can see what they are discarding and the reflog can get it back.
 * A button in an audit UI is the wrong instrument, whatever permissions sit in
 * front of it, so these are refused at the policy layer rather than left
 * un-implemented — un-implemented is a state someone can change by accident.
 */
const CODE_HISTORY_ACTIONS = new Set<string>([
  "github.push",
  "github.pr_opened",
  "github.pr_merged",
  "github.pr_closed",
]);

/**
 * Undo operations the app can actually carry out. A payload naming anything
 * else is a bug, an unimplemented feature, or a tampered row; all three should
 * surface as an error rather than a silent success.
 */
export const ALLOWED_UNDO_ACTIONS = new Set<string>([
  "delete_branch", "recreate_branch", "rename_branch",
  "delete_protection", "restore_protection", "undo_override_protection",
  "delete_ruleset", "recreate_ruleset", "undo_override_ruleset",
  "enable_dependabot", "disable_dependabot",
  "delete_template", "restore_template", "revert_template",
  "delete_widget", "restore_widget", "revert_widget",
  "delete_scanner", "restore_scanner", "revert_scanner",
  "delete_exclusion", "restore_exclusion", "revert_exclusion",
]);

/**
 * What each undo operation requires of the person asking for it.
 *
 * Undoing something is doing something. If a person could not have performed
 * the original action, they must not be able to reverse it either — and the
 * check has to be per-repository, because being on the admin team says nothing
 * about whether you can touch a particular repo.
 *
 * Keyed on the operation rather than on the entry's `repo` field, because that
 * field is overloaded — AWS guardrail rows put a log group name or "*" in it.
 *
 * `repo` mirrors what GitHub demands of the forward call: creating a branch
 * needs push, while protection, rulesets and Dependabot need admin. `adminTeam`
 * mirrors the Control Hub's own gates, for settings GitHub knows nothing about.
 */
interface UndoRequirement {
  repo?: RepoLevel;
  adminTeam?: boolean;
}

const UNDO_REQUIREMENTS: Record<string, UndoRequirement> = {
  // Branches. Recreating one only needs push; deleting a template's branch is
  // deleting a protected branch, which GitHub gates on admin.
  recreate_branch:          { repo: "push" },
  delete_branch:            { repo: "admin" },
  rename_branch:            { repo: "admin" },

  // Protection and rulesets are admin-only on GitHub's side.
  delete_protection:        { repo: "admin" },
  restore_protection:       { repo: "admin" },
  undo_override_protection: { repo: "admin" },
  delete_ruleset:           { repo: "admin" },
  recreate_ruleset:         { repo: "admin" },
  undo_override_ruleset:    { repo: "admin" },
  enable_dependabot:        { repo: "admin" },
  disable_dependabot:       { repo: "admin" },

  // Templates are org-wide: one edit changes what every future repo gets, so
  // creating them is gated on the Control Hub admin team and undoing them
  // has to be gated the same way.
  delete_template:          { adminTeam: true },
  restore_template:         { adminTeam: true },
  revert_template:          { adminTeam: true },

  // Dashboard and scanner configuration carry no gate on the way in, so they
  // carry none on the way out. Listed explicitly rather than defaulted, so a
  // new operation cannot inherit "no checks" by omission.
  delete_widget: {},    restore_widget: {},    revert_widget: {},
  delete_scanner: {},   restore_scanner: {},   revert_scanner: {},
  delete_exclusion: {}, restore_exclusion: {}, revert_exclusion: {},
};

/** What undoing this entry demands. Unknown operations demand the most. */
export function undoRequirement(entry: ActivityEntry): UndoRequirement {
  const action = entry.undoPayload?.action;
  if (!action) return {};
  return UNDO_REQUIREMENTS[action] ?? { repo: "admin", adminTeam: true };
}

/** True when any entry here needs Control Hub admin to reverse. */
export function needsAdminTeam(entries: ActivityEntry[]): boolean {
  return entries.some(e => undoRequirement(e).adminTeam === true);
}

/** True when this row names an operation the app can carry out. */
export function isReversible(entry: ActivityEntry): boolean {
  return !!entry.undoPayload && ALLOWED_UNDO_ACTIONS.has(entry.undoPayload.action);
}

/**
 * Why this entry cannot be undone, or null if it can be. The string is shown
 * to the user, so it says what to do instead rather than just refusing.
 *
 * `descendants` matters because a parent often carries no payload of its own —
 * applying a template records the parent and does the work in its children.
 * Judging the parent alone would refuse the most common undo in the app.
 */
export function undoBlockedReason(entry: ActivityEntry, descendants: ActivityEntry[] = []): string | null {
  if (CODE_HISTORY_ACTIONS.has(entry.action)) {
    return "Commits, pushes and merges cannot be undone from the Control Hub. " +
      "This entry records what happened in GitHub; reverting it is a git operation, " +
      "done in the repository by someone who can see what would be discarded.";
  }

  if (entry.source === "github") {
    return "This entry records a change made directly in GitHub, not an action the " +
      "Control Hub took, so there is nothing here to reverse.";
  }

  if (entry.undoPayload && !ALLOWED_UNDO_ACTIONS.has(entry.undoPayload.action)) {
    return `Undoing "${entry.undoPayload.action}" is not supported.`;
  }

  if (!isReversible(entry) && !descendants.some(isReversible)) {
    return "This action cannot be undone.";
  }

  return null;
}

/** True when carrying out this undo requires access to entry.repo. */
export function needsRepoWrite(entry: ActivityEntry): boolean {
  return !!undoRequirement(entry).repo && !!entry.repo;
}

/**
 * Repositories an undo would touch, grouped by the level each one needs, so a
 * single pre-flight can ask GitHub the right question per repo.
 */
export function reposByLevel(entries: ActivityEntry[]): Record<RepoLevel, string[]> {
  const out: Record<RepoLevel, Set<string>> = { push: new Set(), admin: new Set() };
  for (const e of entries) {
    const level = undoRequirement(e).repo;
    if (level && e.repo) out[level].add(e.repo);
  }
  // A repo needing admin does not also need to be checked for push.
  for (const r of out.admin) out.push.delete(r);
  return { push: [...out.push], admin: [...out.admin] };
}
