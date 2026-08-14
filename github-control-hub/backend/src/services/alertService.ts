import crypto from "crypto";

import { logActivity } from "./activityService";
import { docClient, usesDynamo, tableName, PutCommand, ScanCommand, GetCommand } from "../utils/dynamo";

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
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  details?: any;
}

const TABLE = () => tableName("ALERTS_TABLE");

// In-memory fallback for local development
let memAlertsStore: SecurityAlert[] = [];

export async function getAlerts(): Promise<SecurityAlert[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as SecurityAlert[]).sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }
  return memAlertsStore.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export async function createAlert(
  repo: string,
  type: AlertType,
  message: string,
  severity: AlertSeverity,
  details?: any
): Promise<SecurityAlert> {
  const newAlert: SecurityAlert = {
    id: crypto.randomUUID(),
    repo,
    type,
    message,
    severity,
    timestamp: new Date().toISOString(),
    resolved: false,
    details,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: newAlert }));
  } else {
    memAlertsStore.unshift(newAlert);
  }

  await logActivity(
    "github.issue_opened" as any,
    "system",
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
    const { getSecuritySettings, getGroup } = await import("./alarmService");
    const { publish } = await import("./notifyService");
    const outcome = await notifySecurityAlert(newAlert, {
      settings: getSecuritySettings,
      topicArnFor: async (id: string) => (await getGroup(id))?.topicArn,
      publish,
      org: process.env.GITHUB_ORG || "",
    });
    if (outcome === "sent") console.log(`[Alarm] Security alert emailed: ${type} on ${repo}`);
    else if (outcome === "no-group") console.error("[Alarm] Security emails are on but no email group is set");
    else if (outcome === "publish-failed") console.error(`[Alarm] Security alert email failed: ${type} on ${repo}`);
  } catch (err) {
    console.error("[Alarm] Security alert notification failed:", (err as Error).message);
  }

  return newAlert;
}

export async function resolveAlert(id: string, user: string): Promise<SecurityAlert | null> {
  if (usesDynamo()) {
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

export async function autoResolveAlerts(repo: string, type: AlertType): Promise<number> {
  const all = await getAlerts();
  const matching = all.filter(a => a.repo === repo && a.type === type && !a.resolved);
  let resolved = 0;
  for (const alert of matching) {
    await resolveAlert(alert.id, "system (auto-resolved)");
    resolved++;
  }
  return resolved;
}

export async function unresolveAlert(id: string): Promise<SecurityAlert | null> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    const alert = result.Item as SecurityAlert | undefined;
    if (!alert) return null;

    const updated: SecurityAlert = {
      ...alert,
      resolved: false,
    };
    delete updated.resolvedAt;
    delete updated.resolvedBy;
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
    return updated;
  }

  const alertIndex = memAlertsStore.findIndex(a => a.id === id);
  if (alertIndex === -1) return null;

  memAlertsStore[alertIndex] = {
    ...memAlertsStore[alertIndex],
    resolved: false,
  };
  delete memAlertsStore[alertIndex].resolvedAt;
  delete memAlertsStore[alertIndex].resolvedBy;

  return memAlertsStore[alertIndex];
}
