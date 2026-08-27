import crypto from "crypto";

import { logActivity, activityExpiry } from "./activityService";
import { docClient, hasTable, tableName, PutCommand, ScanCommand, GetCommand, scanAll } from "../utils/dynamo";

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
   * Optional because rows written before this existed do not have it, and
   * because a few alerts come from a sweep rather than from somebody acting.
   *
   * It was computed and then dropped: the webhook worker reads it for the
   * activity log and passed nothing to `createAlert`. So the record of a
   * privilege change knew who *received* it and not who *granted* it, which
   * is the half a reviewer actually asks about, and the half any "this is
   * expected" rule has to match on.
   */
  actor?: string;
  /**
   * The specific thing this alert is about, where there is one.
   *
   * The member's login, the branch pattern, the ruleset's name. Not the
   * repository, which `repo` already holds, and not a description: this is
   * matched against the reversal event, so it has to be the same string
   * GitHub sends both times.
   *
   * Deliberately the ruleset's **name** rather than its id, because a
   * recreated ruleset gets a new id and would never match.
   *
   * Absent on repository-level alerts, where the repository is the subject,
   * and on rows written before this existed.
   */
  subject?: string;
  /**
   * Epoch seconds at which DynamoDB may delete this row.
   *
   * An alert is a record of something that happened, not a task, so it ages
   * out the way the activity log does rather than waiting for somebody to
   * clear it. Before this the table had no expiry at all and the only way a
   * row ever left was by hand, which is the queue this feature was built to
   * remove.
   *
   * Rows written before this existed have no `ttl` and are never expired by
   * DynamoDB. That is the intended outcome: turning expiry on does not
   * retroactively delete history somebody may still want.
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
  const { details, occurredAt, actor, subject } = ctx;
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
    `Security Alert [${severity.toUpperCase()}]: ${message}`,
    details,
    "app"
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
    if (outcome === "sent") console.log(`[Alarm] Security alert emailed: ${type} on ${repo}`);
    else if (outcome === "buffered") console.log(`[Alarm] Security alert buffered for grouping: ${type} on ${repo}`);
    else if (outcome === "no-group") console.error("[Alarm] Security emails are on but no email group is set");
    else if (outcome === "publish-failed") console.error(`[Alarm] Security alert email failed: ${type} on ${repo}`);
  } catch (err) {
    console.error("[Alarm] Security alert notification failed:", (err as Error).message);
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
 * Without it this matched on repository and type alone, so removing **one** of
 * two people added to a repository marked *both* their alerts as undone, and
 * restoring protection on one branch marked every branch in the repository.
 *
 * That was survivable while `resolved` only meant "off the queue". It is not
 * survivable now that the page prints "undone" as a statement about what
 * happened on GitHub, because for the second person that statement is false.
 *
 * **A row with no subject is left alone when a subject is given.** Those are
 * rows written before this was recorded, and there is no way to tell what they
 * were about. Closing them would be the original bug; saying nothing is the
 * honest answer. They age out on their own.
 *
 * Called with no subject for a repository-level reversal, such as a repository
 * being made private again, where the repository *is* the subject.
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
    // "somebody looked at it" — there is no button any more — so the only
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

