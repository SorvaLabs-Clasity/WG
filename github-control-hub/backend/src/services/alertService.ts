import { v4 as uuidv4 } from "uuid";
import { logActivity } from "./activityService";
import { getOrg } from "../github/client";

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

let alertsStore: SecurityAlert[] = [];

export function getAlerts(): SecurityAlert[] {
  return alertsStore.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export function createAlert(
  repo: string,
  type: AlertType,
  message: string,
  severity: AlertSeverity,
  details?: any
): SecurityAlert {
  const newAlert: SecurityAlert = {
    id: uuidv4(),
    repo,
    type,
    message,
    severity,
    timestamp: new Date().toISOString(),
    resolved: false,
    details,
  };
  alertsStore.unshift(newAlert);

  // Log this in activity too for visibility
  logActivity(
    "github.issue_opened" as any, // mapping to a general warning
    "system",
    repo,
    "security_alert",
    `Security Alert [${severity.toUpperCase()}]: ${message}`,
    details,
    "app"
  );

  return newAlert;
}

export function resolveAlert(id: string, user: string): SecurityAlert | null {
  const alertIndex = alertsStore.findIndex(a => a.id === id);
  if (alertIndex === -1) return null;

  alertsStore[alertIndex] = {
    ...alertsStore[alertIndex],
    resolved: true,
    resolvedAt: new Date().toISOString(),
    resolvedBy: user,
  };

  return alertsStore[alertIndex];
}
