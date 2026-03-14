export type ActivityAction =
  | "branch.create"
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
  | "repo.created"
  | "repo.publicized"
  | "github.push"
  | "github.pr_opened"
  | "github.pr_merged"
  | "github.pr_closed"
  | "github.issue_opened"
  | "github.branch_protection_edited"
  | "github.ruleset_edited"
  | "audit.event";

export interface UndoPayload {
  action: string;
  params: Record<string, any>;
}

export interface RetryPayload {
  action: string;
  params: Record<string, any>;
}

export interface Activity {
  id: string;
  source: "app" | "github" | "audit";
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
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
