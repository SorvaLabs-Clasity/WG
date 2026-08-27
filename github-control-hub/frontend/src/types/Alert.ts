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
  /** Who made the change. Absent on rows written before this was recorded. */
  actor?: string;
  /** The member, branch or ruleset this is about, where there is one. */
  subject?: string;
  /**
   * Set when the nightly walk found this rather than a webhook reporting it.
   * The timestamp is then when it was *noticed*, not when it happened.
   */
  source?: "reconciliation";
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
  details?: any;
}
