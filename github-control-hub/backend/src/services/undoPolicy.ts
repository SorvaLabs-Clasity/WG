import type { ActivityEntry } from "./activityService";

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
 * Undo operations that write to a GitHub repository, so the caller must have
 * write access to it.
 *
 * Keyed on the operation rather than on the entry's `repo` field, because that
 * field is overloaded — AWS guardrail rows put a log group name or "*" in it.
 */
const REPO_SCOPED_UNDO_ACTIONS = new Set<string>([
  "delete_branch", "recreate_branch", "rename_branch",
  "delete_protection", "restore_protection", "undo_override_protection",
  "delete_ruleset", "recreate_ruleset", "undo_override_ruleset",
  "enable_dependabot", "disable_dependabot",
]);

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

/** True when carrying out this undo requires write access to entry.repo. */
export function needsRepoWrite(entry: ActivityEntry): boolean {
  return !!entry.undoPayload
    && REPO_SCOPED_UNDO_ACTIONS.has(entry.undoPayload.action)
    && !!entry.repo;
}

/** Distinct repositories an undo of these entries would write to. */
export function reposNeedingWrite(entries: ActivityEntry[]): string[] {
  return [...new Set(entries.filter(needsRepoWrite).map(e => e.repo))];
}
