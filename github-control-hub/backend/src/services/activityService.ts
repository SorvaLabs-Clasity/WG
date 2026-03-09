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
  | "repo.ruleset.delete";

export interface ActivityEntry {
  id: string;
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  diff?: any;
  timestamp: string;
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
  diff?: any
): ActivityEntry {
  const entry: ActivityEntry = {
    id: crypto.randomUUID(),
    action,
    actor,
    repo,
    target,
    details,
    diff,
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
