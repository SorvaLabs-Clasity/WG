import { buildMessage, formatTimestamp } from "./message";
import { meetsMinimumSeverity } from "./evaluate";

/**
 * The security-tab toggle: email when an alert is recorded.
 *
 * Event-driven rather than polled. createAlert already runs the moment the
 * webhook worker sees something worth alerting on — a repository going public,
 * branch protection disappearing — so hooking in here costs one SNS call and
 * arrives in seconds, where a scheduled sweep would arrive in minutes and cost
 * a GitHub read every time.
 */

export interface NotifiableAlert {
  repo: string;
  type: string;
  message: string;
  severity: string;
  timestamp: string;
}

export interface SecurityNotifyDeps {
  settings: () => Promise<{
    enabled: boolean; groupId?: string; minSeverity: string;
    subjectTemplate: string; bodyTemplate: string; timezone?: string;
  }>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  publish: (topicArn: string, subject: string, body: string) => Promise<boolean>;
  org: string;
}

export type NotifyOutcome =
  | "sent" | "disabled" | "below-threshold" | "no-group" | "publish-failed";

export async function notifySecurityAlert(
  alert: NotifiableAlert,
  deps: SecurityNotifyDeps,
): Promise<NotifyOutcome> {
  const settings = await deps.settings();
  if (!settings.enabled) return "disabled";

  // A low-severity alert on a busy organization is a daily occurrence. The
  // floor is what keeps the mailbox worth reading.
  if (!meetsMinimumSeverity(alert.severity, settings.minSeverity)) return "below-threshold";

  if (!settings.groupId) return "no-group";
  const topicArn = await deps.topicArnFor(settings.groupId);
  if (!topicArn) return "no-group";

  const { subject, body } = buildMessage(settings.subjectTemplate, settings.bodyTemplate, {
    repo: alert.repo,
    message: alert.message,
    severity: alert.severity,
    state: "ALARM",
    org: deps.org,
    time: formatTimestamp(alert.timestamp, settings.timezone),
    widget: alert.type,
  });

  return (await deps.publish(topicArn, subject, body)) ? "sent" : "publish-failed";
}
