import crypto from "crypto";

import { logActivity, activityExpiry } from "./activityService";
import { docClient, hasTable, tableName, PutCommand, ScanCommand, GetCommand, QueryCommand, scanAll } from "../utils/dynamo";

export type AlertSeverity = "critical" | "high" | "medium" | "low";
export type AlertType =
  | "protection_removed"
  | "ruleset_disabled"
  | "repo_made_public"
  | "admin_added"
  | "protection_drift"
  | "user_promoted"
  | "team_elevated"
  | "team_added"
  | "team_removed"
  | "team_permission_changed"
  | "suspicious_activity";

export interface SecurityAlert {
  id: string;
  repo: string;
  type: AlertType;
  message: string;
  severity: AlertSeverity;
  timestamp: string;
  /**
   * Who made the change, from the webhook's `sender.login`.
   *
   * Optional, because a few alerts come from a sweep rather than from somebody
   * acting, and older rows do not carry it.
   *
   * Without it the record of a privilege change knows who *received* it and not
   * who *granted* it, which is the half a reviewer asks about and the half any
   * "this is expected" rule has to match on.
   */
  actor?: string;
  /**
   * The specific thing this alert is about, where there is one.
   *
   * The member's login, the branch pattern, the ruleset's name. Not the
   * repository, which `repo` holds, and not a description: it is matched
   * against the reversal event, so it must be the same string GitHub sends
   * both times.
   *
   * The ruleset's **name** rather than its id, because a recreated ruleset gets
   * a new id and would never match.
   *
   * Absent on repository-level alerts, where the repository is the subject.
   */
  subject?: string;
  /**
   * How this alert came to exist.
   *
   * Absent means the ordinary path: GitHub sent a webhook and the worker
   * recorded it, so the timestamp is when it happened and `actor` is who did
   * it. `"reconciliation"` means the nightly walk noticed the value had
   * changed since the last walk and no webhook had ever arrived, in which case
   * **the timestamp is when it was noticed, not when it happened**, and nobody
   * knows who did it.
   *
   * The page has to say which, because the two look identical otherwise and
   * one of them carries a timestamp that is a guess.
   */
  source?: "reconciliation";
  /**
   * Constant partition key for the time-ordered index. Always `"ALERT"`.
   *
   * A scan returns items in hash order, so a scan with a `Limit` cannot answer
   * "the newest five hundred": it returns an arbitrary five hundred. The index
   * makes a real time-ordered read possible, so a page costs what it returns
   * rather than the whole table.
   *
   * One partition for the whole feed, as the activity table does. A partition
   * holds 10 GB, far past 13 months of security events.
   *
   * Rows with no `feed` are invisible to the index until
   * scripts/backfill-alert-feed.sh runs.
   */
  feed?: string;
  /**
   * Epoch seconds at which DynamoDB may delete this row.
   *
   * An alert records something that happened, not a task, so it ages out the
   * way the activity log does rather than waiting for somebody to clear it.
   * With no expiry the only way a row leaves is by hand, which is the queue
   * this feature exists to remove.
   *
   * Rows with no `ttl` are never expired. That is intended: turning expiry on
   * does not retroactively delete history somebody may still want.
   */
  ttl?: number;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  details?: any;
}

/**
 * Written into `resolvedBy` when the condition an alert reported was undone.
 *
 * The page shows these as "reverted". Rows carrying somebody's login instead
 * are from the era when clearing an alert by hand was a thing, and mean only
 * that a person pressed a button that no longer exists.
 */
export const REVERTED_BY = "system (auto-resolved)";

/** The one partition key the time index uses. See the `feed` field. */
export const ALERT_FEED = "ALERT";

/** The index that makes a time-ordered read possible. */
export const ALERT_FEED_INDEX = "feed-index";

const TABLE = () => tableName("ALERTS_TABLE");

/**
 * When a row may be deleted. Matches the activity log's retention exactly.
 *
 * DynamoDB deletes expired items within about 48 hours of the timestamp rather
 * than at it, so this is a floor and not a deadline.
 */
export function alertExpiry(iso: string): number {
  return activityExpiry(iso);
}

// In-memory fallback for local development
let memAlertsStore: SecurityAlert[] = [];

/**
 * How far back the Security tab asks for by default.
 *
 * The same twelve weeks the charts draw. Asking for a window rather than a row
 * count is what makes the default request cost what the page actually shows,
 * however large the table has grown behind it.
 */
export const DEFAULT_WINDOW_WEEKS = 12;

/**
 * A ceiling on one response, whatever the window holds.
 *
 * Twelve weeks is normally a few hundred rows. It is not a bound: an
 * organization enabling Dependabot across a monorepo, or a webhook storm, can
 * put tens of thousands into a window. Past this the response says it is
 * incomplete and hands back a cursor, rather than growing without limit.
 */
export const PAGE_LIMIT = 3000;

export interface AlertPage {
  alerts: SecurityAlert[];
  /** Opaque; pass it back to continue into older rows. Null at the end. */
  cursor: string | null;
  /** True when `alerts` is everything in the window, with nothing behind it. */
  complete: boolean;
}

const encode = (k: unknown) => Buffer.from(JSON.stringify(k)).toString("base64");
function decode(c?: string): Record<string, any> | undefined {
  if (!c) return undefined;
  try {
    return JSON.parse(Buffer.from(c, "base64").toString("utf8"));
  } catch {
    // A cursor from an older deploy, or a truncated one. Starting from the top
    // is the safe answer: worse than continuing, far better than an error page.
    return undefined;
  }
}

/**
 * One page of alerts, newest first.
 *
 * Reads through the time index rather than scanning, so the cost is what comes
 * back rather than the size of the table. Returning every row on every poll is
 * fine at seventeen and ships megabytes at ten thousand.
 *
 * **Rows with no `feed` attribute are invisible here.** The backfill script
 * gives them one; until it runs they are still readable through `getAlerts()`,
 * which scans.
 */
export async function getAlertsPage(opts: {
  since?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<AlertPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? PAGE_LIMIT), PAGE_LIMIT);

  if (!hasTable("ALERTS_TABLE")) {
    const all = (await getAlerts()).filter(a => !opts.since || a.timestamp >= opts.since!);
    return { alerts: all.slice(0, limit), cursor: null, complete: all.length <= limit };
  }

  const res = await docClient.send(new QueryCommand({
    TableName: TABLE(),
    IndexName: ALERT_FEED_INDEX,
    KeyConditionExpression: opts.since
      ? "#f = :f AND #ts >= :since"
      : "#f = :f",
    ExpressionAttributeNames: { "#f": "feed", ...(opts.since ? { "#ts": "timestamp" } : {}) },
    ExpressionAttributeValues: { ":f": ALERT_FEED, ...(opts.since ? { ":since": opts.since } : {}) },
    // Newest first, which is the only order this page is ever read in.
    ScanIndexForward: false,
    // One more than asked for, so "is there another page" is answered by the
    // same read instead of a second one that might disagree with it.
    Limit: limit + 1,
    ExclusiveStartKey: decode(opts.cursor),
  }));

  const items = (res.Items ?? []) as SecurityAlert[];
  const more = items.length > limit;
  const alerts = more ? items.slice(0, limit) : items;

  return {
    alerts,
    // The key of the last row handed back, not DynamoDB's own
    // LastEvaluatedKey: that points past the extra row we asked for and would
    // skip it on the next page.
    cursor: more ? encode({
      feed: ALERT_FEED,
      timestamp: alerts[alerts.length - 1].timestamp,
      id: alerts[alerts.length - 1].id,
    }) : null,
    complete: !more && !opts.cursor,
  };
}

/**
 * Every alert, by scanning.
 *
 * Kept for the callers that genuinely need all of them and run rarely: the
 * nightly drift check, which has to know what is already on the record before
 * it raises anything. Not for serving a page.
 */
export async function getAlerts(): Promise<SecurityAlert[]> {
  if (hasTable("ALERTS_TABLE")) {
    // Paged: a bare scan stops at 1MB without saying so, and a list that
    // silently loses its tail is worse here than an error would be.
    return (await scanAll<SecurityAlert>(TABLE())).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
  return memAlertsStore.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export interface AlertContext {
  details?: any;
  /**
   * When the event happened, if known. Defaults to now.
   *
   * Without it every alert carried the moment the worker processed it, so a
   * redelivered webhook produced an alert dated today for something that
   * happened last week, and a queue backlog quietly shifted every timestamp.
   */
  occurredAt?: string;
  /** Who did it. See the field on SecurityAlert. */
  actor?: string;
  /** What it is about, for matching a later reversal. See the field. */
  subject?: string;
  /** How it was found. See the field on SecurityAlert. */
  source?: "reconciliation";
}

/**
 * The optional half is an object rather than four more positional arguments.
 *
 * It had reached `(repo, type, message, severity, details, occurredAt, actor)`
 * and was about to take an eighth, at which point every call site is a row of
 * bare values and `undefined`s and the compiler cannot tell you that two of
 * them are the wrong way round.
 */
export async function createAlert(
  repo: string,
  type: AlertType,
  message: string,
  severity: AlertSeverity,
  ctx: AlertContext = {},
): Promise<SecurityAlert> {
  const { details, occurredAt, actor, subject, source } = ctx;
  const newAlert: SecurityAlert = {
    id: crypto.randomUUID(),
    repo,
    type,
    message,
    severity,
    timestamp: occurredAt || new Date().toISOString(),
    // Omitted rather than written empty: DynamoDB will hold an empty string,
    // and "" reads as an actor named nothing rather than as an unknown one.
    ...(actor ? { actor } : {}),
    ...(subject ? { subject } : {}),
    ...(source ? { source } : {}),
    feed: ALERT_FEED,
    // Same retention as the activity log, and for the same reason: these are
    // two records of the same events, and two different expiry dates would
    // mean the Activity tab could show something the Security tab had
    // silently dropped.
    ttl: alertExpiry(occurredAt || new Date().toISOString()),
    resolved: false,
    details,
  };

  if (hasTable("ALERTS_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: newAlert }));
  } else {
    memAlertsStore.unshift(newAlert);
  }

  // Its own action, not "issue opened".
  //
  // This was `"github.issue_opened" as any`, and the cast is the tell: nothing
  // here opens an issue. The feed labelled every security alert "PR Opened"'s
  // neighbour, which is a different event on a different part of GitHub, and
  // the one row somebody scanning for a security alert would skip over.
  await logActivity(
    "security.alert",
    // The person, when one is known. "system" on every security row made the
    // Activity tab's actor filter useless for exactly the rows most worth
    // filtering by actor.
    actor || "system",
    repo,
    "security_alert",
    // Shown in the feed's details column. "Important event" here and
    // "Security Alert" on rows written before the rename, which is why the
    // backfill script matches either prefix.
    `Important event [${severity.toUpperCase()}]: ${message}`,
    details,
    "app",
    undefined,
    undefined,
    // Which event this was, so the feed can say "Repository made public"
    // rather than the generic "Security Alert" that every one of these shared.
    // The same field is what the "important events" filter selects on.
    { importantKind: type },
  );

  // Emailed if the security toggle is on. Wrapped and swallowed on purpose:
  // the alert is already recorded by this point, and a failure to notify must
  // not turn into a failure to alert. The webhook worker would otherwise
  // release its claim and retry the whole delivery, duplicating activity rows
  // and alerts because SNS was briefly unavailable.
  try {
    const { notifySecurityAlert } = await import("../alarms/securityNotify");
    const { getSecuritySettings, getGroup, bufferNotification } = await import("./alarmService");
    const { publish } = await import("./notifyService");
    const outcome = await notifySecurityAlert(newAlert, {
      settings: getSecuritySettings,
      topicArnFor: async (id: string) => (await getGroup(id))?.topicArn,
      publish,
      org: process.env.GITHUB_ORG || "",
      // Anything below critical waits for the next flush, where a burst is
      // grouped into one message. A team added to a hundred repositories used
      // to arrive as a hundred emails for one thing somebody did once.
      buffer: async (row) => {
        await bufferNotification("security", row.repo, {
          repo: row.repo,
          message: row.subject,
          severity: row.severity,
          widget: row.type,
        }, row.occurredAt);
      },
    });
    if (outcome === "sent") console.log(`[Alarm] Important event emailed: ${type} on ${repo}`);
    else if (outcome === "buffered") console.log(`[Alarm] Important event buffered for grouping: ${type} on ${repo}`);
    else if (outcome === "no-group") console.error("[Alarm] Security emails are on but no email group is set");
    else if (outcome === "publish-failed") console.error(`[Alarm] Important event email failed: ${type} on ${repo}`);
  } catch (err) {
    console.error("[Alarm] Important event notification failed:", (err as Error).message);
  }

  return newAlert;
}

export async function resolveAlert(id: string, user: string): Promise<SecurityAlert | null> {
  if (hasTable("ALERTS_TABLE")) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    const alert = result.Item as SecurityAlert | undefined;
    if (!alert) return null;

    const updated: SecurityAlert = {
      ...alert,
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy: user,
    };
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
    return updated;
  }

  const alertIndex = memAlertsStore.findIndex(a => a.id === id);
  if (alertIndex === -1) return null;

  memAlertsStore[alertIndex] = {
    ...memAlertsStore[alertIndex],
    resolved: true,
    resolvedAt: new Date().toISOString(),
    resolvedBy: user,
  };

  return memAlertsStore[alertIndex];
}

/**
 * Close the alerts a reversal actually undoes.
 *
 * `subject` is the member's login, the branch pattern or the ruleset name.
 * Matching on repository and type alone would mark both alerts undone when one
 * of two added people is removed, and every branch undone when one is
 * reprotected. The page prints "undone" as a statement about what happened on
 * GitHub, so for the second person that statement would be false.
 *
 * **A row with no subject is left alone when a subject is given.** Those
 * predate the field and there is no way to tell what they were about, so
 * closing them would be a guess. They age out on their own.
 *
 * Called with no subject for a repository-level reversal, such as a repository
 * being made private again, where the repository is the subject.
 */
export async function autoResolveAlerts(
  repo: string,
  type: AlertType,
  subject?: string,
): Promise<number> {
  const all = await getAlerts();
  const matching = all.filter(a =>
    a.repo === repo && a.type === type && !a.resolved
    && (subject === undefined || a.subject === subject));
  let resolved = 0;
  for (const alert of matching) {
    // A marker the page reads, not a person. `resolved` no longer means
    // "somebody looked at it". There is no button any more, so the only
    // thing it still records is that the change was undone, which is worth
    // showing beside the original event.
    await resolveAlert(alert.id, REVERTED_BY);
    resolved++;
  }
  return resolved;
}

/*
 * `unresolveAlert` was removed with the Resolve button.
 *
 * It existed to undo a manual clear, and there is no manual clear any more.
 * `resolveAlert` stays, because the webhook worker still calls it through
 * `autoResolveAlerts` when a change is undone.
 */

