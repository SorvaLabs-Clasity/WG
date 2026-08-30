import { buildMessage, formatTimestamp } from "./message";
import { meetsMinimumSeverity } from "./evaluate";

/**
 * The security-tab toggle: email when an alert is recorded.
 *
 * Event-driven rather than polled. createAlert already runs the moment the
 * webhook worker sees something worth alerting on, a repository going public,
 * branch protection disappearing, so hooking in here costs one SNS call and
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
    teamsSubjectTemplate?: string; teamsBodyTemplate?: string;
  }>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  publish: (topicArn: string, subject: string, body: string,
    teamsText?: { subject: string; body: string }) => Promise<boolean>;
  org: string;
  /** Absent in tests that only exercise the immediate path. */
  buffer?: (row: {
    repo: string; subject: string; severity: string; type: string; occurredAt: string;
  }) => Promise<void>;
}

export type NotifyOutcome =
  | "sent" | "disabled" | "below-threshold" | "no-group" | "publish-failed"
  /** Held for the next flush, so a burst arrives as one message. */
  | "buffered";

/**
 * Which alerts go out at once, and which wait to be grouped.
 *
 * Critical means somebody needs to know now: a repository is public, or branch
 * protection is gone. Those publish immediately, one each, and a burst of them
 * is a burst worth having in the mailbox.
 *
 * Everything below critical waits for the next flush. A team added to a hundred
 * repositories is one action, and it used to arrive as a hundred separate
 * emails, which is the shape that teaches people to filter the whole feed into
 * a folder they never open.
 */
export function sendsImmediately(severity: string): boolean {
  return (severity ?? "").toLowerCase() === "critical";
}

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

  // Below critical, hand it to the buffer and let the flush group it with
  // whatever else arrives in the same window.
  if (!sendsImmediately(alert.severity) && deps.buffer) {
    await deps.buffer({
      repo: alert.repo,
      // What was done, not which row it was. The flush groups on this, so it is
      // what decides whether a hundred rows become one email.
      subject: alert.message.replace(/\s+on\s+\S+$/, "").trim() || alert.type,
      severity: alert.severity,
      type: alert.type,
      occurredAt: alert.timestamp,
    });
    return "buffered";
  }

  const vars = {
    repo: alert.repo,
    message: alert.message,
    severity: alert.severity,
    state: "ALARM",
    org: deps.org,
    time: formatTimestamp(alert.timestamp, settings.timezone),
    widget: alert.type,
  };
  const { subject, body } = buildMessage(settings.subjectTemplate, settings.bodyTemplate, vars);

  // Unset means the email wording. See notifyService.publish.
  const teamsText = (settings.teamsSubjectTemplate || settings.teamsBodyTemplate)
    ? buildMessage(
        settings.teamsSubjectTemplate || settings.subjectTemplate,
        settings.teamsBodyTemplate || settings.bodyTemplate,
        vars)
    : undefined;

  return (await deps.publish(topicArn, subject, body, teamsText)) ? "sent" : "publish-failed";
}
