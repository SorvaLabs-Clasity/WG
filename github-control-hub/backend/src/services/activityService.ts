import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, QueryCommand } from "../utils/dynamo";
import { createOctokit, getSystemToken } from "../github/client";
import { fetchOrgAuditLog, type OrgAuditLogEvent } from "../github/client";
import { getOrgConfig } from "./orgConfigService";

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

export interface ActivityEntry {
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
  children?: ActivityEntry[];
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

const TABLE = () => tableName("ACTIVITY_TABLE");

// In-memory fallback for local development
const memoryLog: ActivityEntry[] = [];

export async function logActivity(
  action: ActivityAction,
  actor: string,
  repo: string,
  target: string,
  details?: string,
  diff?: any,
  source: "app" | "github" = "app",
  prNumber?: number,
  commitSha?: string,
  extra?: { parentId?: string; undoPayload?: UndoPayload; failed?: boolean; errorMessage?: string; retryPayload?: RetryPayload; conflictPayload?: ActivityEntry["conflictPayload"]; linkedActivityId?: string; undone?: boolean }
): Promise<ActivityEntry> {
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
    ...(extra?.parentId && { parentId: extra.parentId }),
    ...(extra?.undoPayload && { undoPayload: extra.undoPayload }),
    ...(extra?.failed && { failed: true }),
    ...(extra?.errorMessage && { errorMessage: extra.errorMessage }),
    ...(extra?.retryPayload && { retryPayload: extra.retryPayload }),
    ...(extra?.conflictPayload && { conflictPayload: extra.conflictPayload }),
    ...(extra?.linkedActivityId && { linkedActivityId: extra.linkedActivityId }),
    ...(extra?.undone !== undefined && { undone: extra.undone }),
  };

  if (usesDynamo()) {
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: `ACTIVITY`,
          sk: `${entry.timestamp}#${entry.id}`,
          ...entry,
        },
      })
    );
  } else {
    memoryLog.unshift(entry);
    if (memoryLog.length > 500) memoryLog.length = 500;
  }

  return entry;
}

export async function getActivity(limit = 50, offset = 0): Promise<ActivityEntry[]> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "ACTIVITY" },
        ScanIndexForward: false,
        Limit: limit + offset,
      })
    );
    const items = (result.Items || []) as ActivityEntry[];
    return items.slice(offset, offset + limit);
  }
  return memoryLog.slice(offset, offset + limit);
}

export async function getActivityForRepo(repo: string, limit = 50): Promise<ActivityEntry[]> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "repo = :repo",
        ExpressionAttributeValues: { ":pk": "ACTIVITY", ":repo": repo },
        ScanIndexForward: false,
        Limit: 200,
      })
    );
    return ((result.Items || []) as ActivityEntry[]).slice(0, limit);
  }
  return memoryLog.filter((e) => e.repo === repo).slice(0, limit);
}

export async function getActivityCount(): Promise<number> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "pk = :pk",
        Select: "COUNT",
        ExpressionAttributeValues: { ":pk": "ACTIVITY" },
      })
    );
    return result.Count || 0;
  }
  return memoryLog.length;
}

function normalizeAuditEventToEntry(event: OrgAuditLogEvent, index: number): ActivityEntry {
  const ts = event["@timestamp"] ?? event.created_at ?? 0;
  const timestamp = typeof ts === "number" ? new Date(ts).toISOString() : new Date().toISOString();
  const actor = (event.actor as string) || "unknown";
  const repo = (event.repo as string) || "";
  const action = (event.action as string) || "event";
  const details = event.data ? `${action}: ${JSON.stringify(event.data).slice(0, 150)}` : action;
  return {
    id: `audit-${ts}-${index}`,
    source: "audit",
    action: "audit.event",
    actor,
    repo,
    target: action,
    details,
    timestamp,
  };
}

/** Fetch org audit log as activity entries (only when org has auditLogs enabled). */
export async function getAuditLogActivity(limit: number): Promise<ActivityEntry[]> {
  const config = await getOrgConfig();
  if (!config.features.auditLogs) return [];

  const token = getSystemToken();
  if (!token) return [];

  try {
    const octokit = createOctokit(token);
    const events = await fetchOrgAuditLog(octokit, { per_page: Math.min(limit, 100) });
    return events.map((e, i) => normalizeAuditEventToEntry(e, i));
  } catch (err) {
    console.error("[activityService] Failed to fetch audit log:", err);
    return [];
  }
}

/** Get activity merged with audit log when Enterprise audit is enabled. */
export async function getActivityMerged(limit: number, offset: number): Promise<ActivityEntry[]> {
  const [appEntries, auditEntries] = await Promise.all([
    getActivity(limit + 100, 0),
    getAuditLogActivity(limit + 50),
  ]);
  const merged = [...appEntries, ...auditEntries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
  return merged.slice(offset, offset + limit);
}

export async function getActivityById(id: string): Promise<ActivityEntry | undefined> {
  if (usesDynamo()) {
    let lastKey: any = undefined;
    for (let page = 0; page < 5; page++) {
      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE(),
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "id = :id",
          ExpressionAttributeValues: { ":pk": "ACTIVITY", ":id": id },
          ScanIndexForward: false,
          Limit: 200,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        })
      );
      const match = (result.Items || [])[0] as ActivityEntry | undefined;
      if (match) return match;
      lastKey = result.LastEvaluatedKey;
      if (!lastKey) break;
    }
    return undefined;
  }
  return memoryLog.find(e => e.id === id);
}

export async function getChildActivities(parentId: string): Promise<ActivityEntry[]> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "pk = :pk",
        FilterExpression: "parentId = :pid",
        ExpressionAttributeValues: { ":pk": "ACTIVITY", ":pid": parentId },
        ScanIndexForward: false,
        Limit: 200,
      })
    );
    return (result.Items || []) as ActivityEntry[];
  }
  return memoryLog.filter(e => e.parentId === parentId);
}

export function buildActivityTree(flat: ActivityEntry[]): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const entry of flat) {
    byId.set(entry.id, { ...entry, children: [] });
  }

  const roots: ActivityEntry[] = [];
  for (const entry of flat) {
    const node = byId.get(entry.id)!;
    if (entry.parentId && byId.has(entry.parentId)) {
      byId.get(entry.parentId)!.children!.push(node);
    } else if (!entry.parentId) {
      roots.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const node of byId.values()) {
    if (node.children && node.children.length === 0) {
      delete node.children;
    } else if (node.children) {
      node.children.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    }
  }

  return roots;
}

export async function markActivityUndone(id: string): Promise<void> {
  const now = new Date().toISOString();
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...entry,
          undone: true,
          undoneAt: now,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.undone = true;
      entry.undoneAt = now;
    }
  }
}

export async function markActivityRedone(id: string): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { undoneAt: _u, undone: _o, children: _c, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          undone: false,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.undone = false;
      delete (entry as any).undoneAt;
    }
  }
}

export async function markActivityRetried(id: string, undoPayload?: UndoPayload): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { failed: _f, errorMessage: _e, retryPayload: _r, children: _c, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          failed: false,
          ...(undoPayload && { undoPayload }),
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.failed = false;
      delete (entry as any).errorMessage;
      delete (entry as any).retryPayload;
      if (undoPayload) entry.undoPayload = undoPayload;
    }
  }
}

export async function updateActivityUndoPayload(id: string, undoPayload: UndoPayload): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { children: _c, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          undoPayload,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.undoPayload = undoPayload;
    }
  }
}

export async function updateActivityConflictResolution(id: string, resolution: "override" | "skip"): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { children: _c, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          conflictResolution: resolution,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.conflictResolution = resolution;
    }
  }
}

export async function clearConflictResolution(id: string): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { children: _c, ...rest } = entry as any;
    delete rest.conflictResolution;
    delete rest.undoPayload;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      delete (entry as any).conflictResolution;
      delete (entry as any).undoPayload;
    }
  }
}

/**
 * Rewrite an entry once the work it describes has actually finished.
 *
 * Long-running actions (auto-apply) must log up front so child entries have a
 * parent to attach to, but that entry is a claim about work not yet done. Call
 * this afterwards so the log reflects the real outcome instead of the intent.
 */
export async function updateActivityOutcome(
  id: string,
  outcome: { details: string; failed: boolean; errorMessage?: string }
): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { children: _c, failed: _f, errorMessage: _e, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          details: outcome.details,
          ...(outcome.failed && { failed: true }),
          ...(outcome.errorMessage && { errorMessage: outcome.errorMessage }),
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      entry.details = outcome.details;
      if (outcome.failed) entry.failed = true;
      else { delete (entry as any).failed; delete (entry as any).errorMessage; }
      if (outcome.errorMessage) (entry as any).errorMessage = outcome.errorMessage;
    }
  }
}

export async function updateActivityError(id: string, errorMessage: string): Promise<void> {
  if (usesDynamo()) {
    const entry = await getActivityById(id);
    if (!entry) return;
    const { children: _c, ...rest } = entry as any;
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: {
          pk: "ACTIVITY",
          sk: `${entry.timestamp}#${entry.id}`,
          ...rest,
          errorMessage,
        },
      })
    );
  } else {
    const entry = memoryLog.find(e => e.id === id);
    if (entry) {
      (entry as any).errorMessage = errorMessage;
    }
  }
}
