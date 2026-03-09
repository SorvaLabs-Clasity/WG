export type ActivityAction =
  | "branch.create"
  | "branch.delete"
  | "branch.protect"
  | "branch.unprotect"
  | "template.apply"
  | "template.create"
  | "template.update"
  | "template.delete"
  | "repo.ruleset.delete"
  | "github.push"
  | "github.pr_opened"
  | "github.pr_merged"
  | "github.pr_closed"
  | "github.issue_opened";

export interface Activity {
  id: string;
  source: "app" | "github";
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  diff?: any;
  timestamp: string;
  prNumber?: number;
  commitSha?: string;
}
