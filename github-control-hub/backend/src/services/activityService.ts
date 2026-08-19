import crypto from "crypto";
import { docClient, usesDynamo, tableName, PutCommand, QueryCommand } from "../utils/dynamo";
import { createOctokit, getSystemToken } from "../github/client";
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
  | "config.import"
  | "config.updated"
  | "audit.event"
  // The AWS guardrail screens. `aws.guardrail` itself is absent on purpose —
  // the Lambda writes that string directly, from a bundle that does not import
  // this file.
  | "aws.guardrail.create"
  | "aws.guardrail.update"
  | "aws.guardrail.delete"
  | "aws.guardrail.run"
  | "aws.guardrail.preview"
  // Collection runs. Not changes to anything in GitHub or AWS — a record that
  // the app went and looked, who asked it to, and what came back. Without them
  // "the page says 0" and "nothing has been collected since Tuesday" were the
  // same observation.
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

export interface ActivityEntry {
  id: string;
  source: "app" | "github" | "audit";
  action: ActivityAction;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  /** Who an audit event was about, when that differs from who performed it. */
  subject?: string;
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

/**
 * How long an activity row is kept.
 *
 * Thirteen months: a full year of audit history plus a month of slack, so an
 * auditor looking back over the last twelve always finds a complete record
 * rather than one that ends mid-period.
 *
 * The consequence worth knowing is that undo stops working on anything past
 * this age — the row carrying the payload is gone. Undoing a year-old change
 * is not something anyone should be doing, but it is a real edge and not a
 * side effect anybody would guess at.
 *
 * DynamoDB deletes expired items within about 48 hours of the timestamp rather
 * than at it, so treat this as a floor, not a deadline.
 */
export const ACTIVITY_RETENTION_MONTHS =
  Number(process.env.ACTIVITY_RETENTION_MONTHS) || 13;

/** Epoch seconds at which a row written at `iso` should expire. */
export function activityExpiry(iso: string): number {
  const d = new Date(iso);
  // Calendar months, not 30-day approximations, so "13 months" means what a
  // person reading the retention policy thinks it means.
  d.setUTCMonth(d.getUTCMonth() + ACTIVITY_RETENTION_MONTHS);
  return Math.floor(d.getTime() / 1000);
}

/** Which collection run. One action per kind, so the feed can be filtered. */
export type SyncKind =
  | "graph" | "compliance" | "query" | "access" | "scanner" | "reminders" | "alarms";

const SYNC_ACTION: Record<SyncKind, ActivityAction> = {
  graph: "sync.graph",
  compliance: "sync.compliance",
  query: "sync.query",
  access: "sync.access",
  scanner: "sync.scanner",
  reminders: "sync.reminders",
  alarms: "sync.alarms",
};

/**
 * The actor for a run nobody pressed a button for.
 *
 * Spelled out rather than left blank: an empty actor reads as missing data, and
 * "who ran this" is the first question asked of any row in this feed.
 */
export const SCHEDULE_ACTOR = "system (schedule)";

/**
 * Records a refresh, sweep or sync.
 *
 * Separate from logActivity because these rows answer a different question. The
 * rest of the feed is "what changed"; these are "when did we last look, and did
 * it work" — the question behind every report of a page showing zero, and one
 * the feed could not answer at all because no collection run wrote anything.
 *
 * Never throws. A run that did its work and then failed to write a log line has
 * still done its work, and turning that into an error would lose the result to
 * report the bookkeeping.
 */
export async function logSync(
  kind: SyncKind,
  actor: string,
  opts: {
    /** What was synced: a repository, a check name, or "*" for everything. */
    target?: string;
    /** What came back. Numbers, not adjectives — this is read to compare runs. */
    details: string;
    failed?: boolean;
    error?: string;
    /** `Date.now()` from before the run, to report how long it took. */
    startedAt?: number;
  },
): Promise<void> {
  try {
    const took = opts.startedAt
      ? ` (${((Date.now() - opts.startedAt) / 1000).toFixed(1)}s)`
      : "";
    await logActivity(
      SYNC_ACTION[kind],
      actor,
      "",
      opts.target ?? "*",
      opts.details + took,
      undefined,
      "app",
      undefined,
      undefined,
      {
        ...(opts.failed && { failed: true }),
        ...(opts.error && { errorMessage: opts.error }),
      },
    );
  } catch (err) {
    console.warn(`[activity] Could not log the ${kind} sync:`, (err as Error)?.message ?? err);
  }
}

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
          ttl: activityExpiry(entry.timestamp),
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

/**
 * When GitHub last reached us, and how long that has been.
 *
 * If the org webhook breaks — a rotated secret, a changed address, the instance
 * down — nothing about the app looks wrong. Auto-apply simply stops happening,
 * and the way you find out is noticing weeks later that a repository never got
 * its template. There is no backfill, so whatever arrived in the meantime is
 * gone.
 *
 * The answer was already in the table: the newest row GitHub caused. This only
 * asks for it.
 */
/**
 * How long the webhook has been silent, read as a verdict.
 *
 * The delivery endpoint failing is invisible: the app keeps serving whatever it
 * last heard, and looks exactly as it does when nothing has happened. The only
 * evidence either way is the age of the most recent event, so that is what this
 * turns into words.
 *
 * The thresholds are wide on purpose. A quiet organization is not a broken one,
 * and three days without a single push, repository or membership event across a
 * whole org is roughly where "quiet" stops being the likelier explanation.
 */
export function webhookHealth(at: string | null, now = Date.now()) {
  const hours = at === null ? null : (now - new Date(at).getTime()) / 3_600_000;
  const status = hours === null ? "unknown"
    : hours < 24 ? "healthy"
    : hours < 72 ? "quiet"
    : "stale";
  return { status, lastEventAt: at, ageHours: hours === null ? null : Math.round(hours * 10) / 10 };
}

export async function lastGitHubEvent(): Promise<{ at: string | null; action: string | null }> {
  const recent = usesDynamo()
    ? await getActivity(60, 0)
    : memoryLog.slice(0, 60);
  const fromGitHub = recent.find(e => e.source === "github");
  return { at: fromGitHub?.timestamp ?? null, action: fromGitHub?.action ?? null };
}

/**
 * How many rows a per-repository lookup may read before giving up.
 *
 * The bound exists because the filter is not a key condition: every row shares
 * one partition key, so DynamoDB reads rows and then discards the ones for
 * other repositories. A quiet repository would otherwise walk thirteen months
 * of the whole organization's history to return nothing.
 *
 * Three thousand rows is far enough back to be a real answer on any
 * organization this app is used on, and small enough that opening the panel on
 * a repository with no activity costs a bounded read rather than a full table.
 */
const REPO_ACTIVITY_MAX_EXAMINED = 3000;

/**
 * One repository's activity.
 *
 * `Limit` on a Query applies to rows **read**, not to rows that survive the
 * filter — the same trap that getActivityById and getChildActivities were
 * moved off indexes to escape, still sitting here. With `Limit: 200` this
 * asked "is this repository among the newest 200 rows in the organization?",
 * which is a different question from the one it appears to answer and gets
 * steadily wronger as the log grows: on a busy org the newest 200 rows are
 * often a single afternoon, so every repository except the two or three
 * touched that afternoon returned an empty history. Empty reads as "nothing
 * ever happened here", which is exactly the wrong conclusion.
 *
 * Paged until enough matches are found, or until the read budget above runs
 * out. No index is added for this: `repo` is empty on a large share of rows
 * (org-wide settings, sync runs, audit events), and a sparse index would be
 * one more thing to provision on an existing table for a panel nobody opens
 * in a loop.
 */
export async function getActivityForRepo(repo: string, limit = 50): Promise<ActivityEntry[]> {
  if (usesDynamo()) {
    const items: ActivityEntry[] = [];
    let lastKey: Record<string, unknown> | undefined;
    let examined = 0;

    while (items.length < limit && examined < REPO_ACTIVITY_MAX_EXAMINED) {
      const result: any = await docClient.send(
        new QueryCommand({
          TableName: TABLE(),
          KeyConditionExpression: "pk = :pk",
          FilterExpression: "repo = :repo",
          ExpressionAttributeValues: { ":pk": "ACTIVITY", ":repo": repo },
          ScanIndexForward: false,
          Limit: 300,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        })
      );
      items.push(...((result.Items || []) as ActivityEntry[]));
      // ScannedCount, not Count: the budget is about how much was read, and
      // Count is only what survived the filter — spending it would make a
      // repository with no rows cost the most.
      examined += result.ScannedCount ?? 0;
      lastKey = result.LastEvaluatedKey;
      if (!lastKey) break;
    }

    return items.slice(0, limit);
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



/**
 * Kept as a named function because routes call it, but there is nothing left to
 * merge: the GitHub audit log needed Enterprise Cloud for API access, the check
 * that would have enabled it was never wired up, and the whole path returned an
 * empty list on every call.
 */
export async function getActivityMerged(limit: number, offset: number): Promise<ActivityEntry[]> {
  const entries = await getActivity(limit + offset, 0);
  return entries.slice(offset, offset + limit);
}

/**
 * Every row shares one partition key, so neither of the lookups below can be
 * expressed as a key condition on the base table. They used to scan the newest
 * rows and filter — and in DynamoDB a Limit applies BEFORE the filter, so both
 * were really asking "is it among the most recent N?" rather than "does it
 * exist?". That answer changes as the log grows: correct at 170 rows, wrong at
 * 200, and wrong silently — an empty result is indistinguishable from a parent
 * that genuinely has no children.
 *
 * Both now go through sparse indexes keyed on the attribute being looked up.
 * Sparse because only rows carrying the attribute are indexed: ID_INDEX covers
 * everything, PARENT_INDEX contains only child rows, which is exactly the set
 * getChildActivities wants.
 */
export const ID_INDEX = "id-index";
export const PARENT_INDEX = "parentId-index";

export async function getActivityById(id: string): Promise<ActivityEntry | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        IndexName: ID_INDEX,
        KeyConditionExpression: "id = :id",
        ExpressionAttributeValues: { ":id": id },
        Limit: 1,
      })
    );
    return (result.Items || [])[0] as ActivityEntry | undefined;
  }
  return memoryLog.find(e => e.id === id);
}

export async function getChildActivities(parentId: string): Promise<ActivityEntry[]> {
  if (usesDynamo()) {
    // Paged rather than capped: a template applied across every repo in a large
    // org produces more children than one page holds, and quietly returning the
    // first page would undo part of a group while reporting all of it.
    const items: ActivityEntry[] = [];
    let lastKey: any = undefined;
    do {
      const result: any = await docClient.send(
        new QueryCommand({
          TableName: TABLE(),
          IndexName: PARENT_INDEX,
          KeyConditionExpression: "parentId = :pid",
          ExpressionAttributeValues: { ":pid": parentId },
          ScanIndexForward: false,
          ...(lastKey && { ExclusiveStartKey: lastKey }),
        })
      );
      items.push(...((result.Items || []) as ActivityEntry[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    return items;
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
