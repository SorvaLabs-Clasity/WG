import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, QueryCommand } from "../utils/dynamo";
import { createOctokit } from "../github/client";
import { fetchOrgAuditLog, type OrgAuditLogEvent } from "../github/client";
import { getOrgConfig } from "./orgConfigService";

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
  | "repo.ruleset.import"
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
  commitSha?: string
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

  const token = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
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
