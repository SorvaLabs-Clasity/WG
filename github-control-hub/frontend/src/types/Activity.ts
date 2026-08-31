export type ActivityAction =
  | "branch.create"
  | "tag.create"
  | "tag.delete"
  | "branch.delete"
  | "branch.rename"
  | "branch.protect"
  | "branch.unprotect"
  | "template.apply"
  | "template.apply.repo"
  | "template.create"
  | "template.update"
  | "template.delete"
  | "exclusion.create"
  | "exclusion.update"
  | "exclusion.delete"
  | "scanner.create"
  | "scanner.update"
  | "scanner.delete"
  | "widget.create"
  | "widget.update"
  | "widget.delete"
  | "dependabot.enable"
  | "dependabot.disable"
  | "repo.ruleset.create"
  | "repo.ruleset.delete"
  | "repo.ruleset.import"
  | "activity.undo"
  | "activity.redo"
  | "activity.retry"
  | "conflict.pending"
  | "conflict.override"
  | "conflict.skip"
  | "security.alert"
  | "repo.created"
  | "repo.deleted"
  | "repo.renamed"
  | "repo.publicized"
  | "github.push"
  | "github.pr_opened"
  | "github.pr_merged"
  | "github.pr_closed"
  | "github.issue_opened"
  | "github.branch_protection_edited"
  | "github.ruleset_edited"
  | "config.import"
  | "config.updated"
  | "aws.guardrail.create"
  | "aws.guardrail.update"
  | "aws.guardrail.delete"
  | "aws.guardrail.run"
  | "aws.guardrail.preview"
  // Collection runs. Kept in step with the backend union in
  // services/activityService.ts; ACTION_CONFIG in ActivityPage is a total
  // Record over this type, so adding one here forces a label to be written.
  | "sync.graph"
  | "sync.compliance"
  | "sync.query"
  | "sync.access"
  | "sync.scanner"
  | "sync.reminders"
  | "sync.alarms";

export interface UndoPayload {
  action: string;
  params: Record<string, any>;
}

export interface RetryPayload {
  action: string;
  params: Record<string, any>;
}

export interface Activity {
  /**
   * Somebody arranging their own board, rather than the organization's.
   *
   * A personal widget or alarm is a real change and belongs in the feed and in
   * the statistics — it is how somebody answers "why did that alert arrive" —
   * but it is not the same event as an administrator changing what everybody
   * sees, and a feed that rendered the two identically would make the
   * organization's own history harder to read.
   */
  personal?: boolean;

  id: string;
  source: "app" | "github";
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  /** Written under the detailed-logging toggle; the view filter keys off it. */
  detailed?: boolean;
  /**
   * Which security event this row recorded, for the rows whose action is
   * `security.alert`.
   *
   * Absent on rows written before it was stored, which fall back to the
   * generic label rather than being hidden.
   */
  importantKind?: string;
  diff?: any;
  timestamp: string;
  prNumber?: number;
  commitSha?: string;
  parentId?: string;
  children?: Activity[];
  undoPayload?: UndoPayload;
  undone?: boolean;
  undoneAt?: string;
  failed?: boolean;
  errorMessage?: string;
  retryPayload?: RetryPayload;
  conflictPayload?: {
    type: "ruleset" | "classic";
    repo: string;
    name: string;
    existingId?: number;
    existingConfig: any;
    templateConfig: any;
    differences: string[];
  };
  conflictResolution?: "override" | "skip";
  linkedActivityId?: string;
}
