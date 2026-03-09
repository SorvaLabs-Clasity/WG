import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, QueryCommand } from "../utils/dynamo";

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
