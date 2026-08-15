import { buildMessage, formatTimestamp } from "./message";
import { meetsMinimumSeverity } from "./evaluate";

/**
 * The Vulnerabilities-tab toggles: email once per Renovate pull request, and
 * once per Dependabot alert.
 *
 * Event-driven, like the security toggle beside it, and for the same reasons.
 * GitHub already tells us the moment either happens, so hooking the webhook
 * costs one SNS call and arrives in seconds. Polling for it would arrive in
 * minutes, spend a GitHub read every cycle whether or not anything changed,
 * and still need somewhere to remember what had already been emailed.
 *
 * That last part is the real argument. "Every new one" means never emailing the
 * same thing twice, and the webhook gives that for free: the delivery lock in
 * the worker already refuses a redelivered id, so a retried delivery cannot
 * produce a second email. A poller would have to keep that state itself, and
 * getting it wrong is either a duplicate or a silence.
 */

export interface RenovatePrEvent {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  openedAt: string;
}

export interface DependabotAlertEvent {
  repo: string;
  package: string;
  summary: string;
  severity: string;
  url: string;
  createdAt: string;
}

export interface FeedNotifyDeps {
  settings: () => Promise<{
    enabled: boolean; groupId?: string; minSeverity?: string;
    subjectTemplate: string; bodyTemplate: string;
  }>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  publish: (topicArn: string, subject: string, body: string) => Promise<boolean>;
  timezone: () => Promise<string>;
  org: string;
}

export type FeedOutcome =
  | "sent" | "disabled" | "below-threshold" | "not-the-bot" | "no-group" | "publish-failed";

/**
 * Whether a pull request author is the configured Renovate bot.
 *
 * A GitHub App's deliveries carry the login with a `[bot]` suffix, while the
 * name a person types into the settings box is usually the one shown on the
 * pull request, without it. Comparing them raw matches nothing and the feature
 * looks broken with no error — the same mismatch that made the Renovate tab
 * return 422 before it accepted both forms.
 */
export function isConfiguredBot(author: string | undefined, bot: string | undefined): boolean {
  if (!author || !bot) return false;
  const strip = (s: string) => s.trim().toLowerCase().replace(/\[bot\]$/, "");
  return strip(author) === strip(bot) && strip(bot).length > 0;
}

export async function notifyRenovatePr(
  pr: RenovatePrEvent,
  bot: string | undefined,
  deps: FeedNotifyDeps,
): Promise<FeedOutcome> {
  const settings = await deps.settings();
  if (!settings.enabled) return "disabled";

  // Checked before the group, so a misconfigured bot name reports as itself
  // rather than as a missing group and sends whoever is debugging to the wrong
  // field.
  if (!isConfiguredBot(pr.author, bot)) return "not-the-bot";

  if (!settings.groupId) return "no-group";
  const topicArn = await deps.topicArnFor(settings.groupId);
  if (!topicArn) return "no-group";

  const { subject, body } = buildMessage(settings.subjectTemplate, settings.bodyTemplate, {
    repo: pr.repo,
    title: pr.title,
    url: pr.url,
    number: String(pr.number),
    org: deps.org,
    state: "ALARM",
    time: formatTimestamp(pr.openedAt, await deps.timezone()),
  });

  return (await deps.publish(topicArn, subject, body)) ? "sent" : "publish-failed";
}

export async function notifyDependabotAlert(
  alert: DependabotAlertEvent,
  deps: FeedNotifyDeps,
): Promise<FeedOutcome> {
  const settings = await deps.settings();
  if (!settings.enabled) return "disabled";

  // A moderate alert on a large dependency tree arrives many times a day. The
  // floor is what keeps the mailbox worth reading; absent, it means no floor
  // rather than a floor of nothing.
  if (settings.minSeverity && !meetsMinimumSeverity(alert.severity, settings.minSeverity)) {
    return "below-threshold";
  }

  if (!settings.groupId) return "no-group";
  const topicArn = await deps.topicArnFor(settings.groupId);
  if (!topicArn) return "no-group";

  const { subject, body } = buildMessage(settings.subjectTemplate, settings.bodyTemplate, {
    repo: alert.repo,
    package: alert.package,
    advisory: alert.summary,
    severity: alert.severity,
    url: alert.url,
    org: deps.org,
    state: "ALARM",
    time: formatTimestamp(alert.createdAt, await deps.timezone()),
  });

  return (await deps.publish(topicArn, subject, body)) ? "sent" : "publish-failed";
}
