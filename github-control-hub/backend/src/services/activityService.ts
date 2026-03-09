import crypto from "crypto";

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

export interface ActivityEntry {
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

/**
 * In-memory store for local development.
 * In production, swap this for DynamoDB writes via the AuditLogTable
 * defined in infra/template.yaml.
 */
const activityLog: ActivityEntry[] = [];

export function logActivity(
  action: ActivityAction,
  actor: string,
  repo: string,
  target: string,
  details?: string,
  diff?: any,
  source: "app" | "github" = "app",
  prNumber?: number,
  commitSha?: string
): ActivityEntry {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    source,
    action,
    actor,
    repo,
    target,
    details,
    diff,
    prNumber,
    commitSha,
    timestamp: new Date().toISOString(),
  };
  activityLog.unshift(entry);

  // Keep last 500 entries in memory
  if (activityLog.length > 500) activityLog.length = 500;

  return entry;
}

export function getActivity(limit = 50, offset = 0): ActivityEntry[] {
  return activityLog.slice(offset, offset + limit);
}

export function getActivityForRepo(repo: string, limit = 50): ActivityEntry[] {
  return activityLog.filter((e) => e.repo === repo).slice(0, limit);
}

export function getActivityCount(): number {
  return activityLog.length;
}
