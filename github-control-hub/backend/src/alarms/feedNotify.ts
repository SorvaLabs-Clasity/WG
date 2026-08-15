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

/**
 * One message covering everything that arrived for a repository.
 *
 * The subject and body templates describe a single item, and a digest is not
 * one — so the templates are used for the *first* item and the rest are listed
 * beneath it. That keeps a customised template meaningful without pretending it
 * can render a list, and keeps the most important line where a phone shows it.
 *
 * Ordered by severity where there is one, so a digest of twenty alerts opens
 * with the critical rather than burying it at position fourteen.
 */
export function buildDigest(
  items: Array<{ item: Record<string, string>; occurredAt: string }>,
  rendered: { subject: string; body: string },
  label: { singular: string; plural: string },
  repo: string,
): { subject: string; body: string } {
  if (items.length <= 1) return rendered;

  const rank = (s?: string) =>
    ({ critical: 4, high: 3, medium: 2, moderate: 2, low: 1 } as Record<string, number>)[
      (s ?? "").toLowerCase()
    ] ?? 0;
  const sorted = [...items].sort((a, b) => {
    const d = rank(b.item.severity) - rank(a.item.severity);
    return d !== 0 ? d : a.occurredAt.localeCompare(b.occurredAt);
  });

  const n = items.length;
  const subject = `[${n}] ${repo}: ${n} ${n === 1 ? label.singular : label.plural}`;

  const lines = sorted.map(({ item }) => {
    const sev = item.severity ? `[${item.severity}] ` : "";
    const what = item.package || item.title || item.number || "(no description)";
    return `  ${sev}${what}${item.url ? `\n    ${item.url}` : ""}`;
  });

  const body =
    `${n} ${n === 1 ? label.singular : label.plural} in ${repo}:\n\n` +
    `${lines.join("\n")}\n\n` +
    `— — —\n\n${rendered.body}`;

  return { subject, body };
}

export type FeedName = "renovate-pr" | "dependabot-alert";

export interface PendingRow {
  id: string;
  feed: FeedName;
  repo: string;
  item: Record<string, string>;
  occurredAt: string;
}

export interface FlushDeps {
  listPending: (feed?: FeedName) => Promise<PendingRow[]>;
  markSent: (ids: string[]) => Promise<void>;
  settings: (feed: FeedName) => Promise<{
    enabled: boolean; groupId?: string; grouping: string;
    subjectTemplate: string; bodyTemplate: string;
  }>;
  topicArnFor: (groupId: string) => Promise<string | undefined>;
  publish: (topicArn: string, subject: string, body: string) => Promise<boolean>;
  timezone: () => Promise<string>;
  org: string;
}

const FEED_LABELS: Record<FeedName, { singular: string; plural: string }> = {
  "renovate-pr": { singular: "Renovate pull request", plural: "Renovate pull requests" },
  "dependabot-alert": { singular: "Dependabot alert", plural: "Dependabot alerts" },
};

/**
 * Turn everything buffered into one message per repository.
 *
 * Grouped by feed *and* repository: a repository can have both a Renovate pull
 * request and a Dependabot alert waiting, and they are different subjects with
 * different templates. Merging them would produce a message no template
 * describes.
 *
 * A group whose publish fails is left unmarked, so the next tick retries it.
 * That risks a duplicate digest if SNS accepted the message and the failure was
 * downstream, which is the right way round: a repeat is noticed and ignored, a
 * silent loss is not noticed at all.
 */
export async function flushPending(deps: FlushDeps): Promise<{
  items: number; repos: number; messages: number; failures: number;
}> {
  const pending = await deps.listPending();
  if (pending.length === 0) return { items: 0, repos: 0, messages: 0, failures: 0 };

  const groups = new Map<string, PendingRow[]>();
  for (const row of pending) {
    const key = `${row.feed} ${row.repo}`;
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  let messages = 0, failures = 0, items = 0;
  const tz = await deps.timezone();

  for (const [key, rows] of groups) {
    const feed = key.split(" ")[0] as FeedName;
    const repo = rows[0].repo;
    const settings = await deps.settings(feed);

    // Turned off, or switched to per-alert, while these sat in the buffer.
    // Marked sent rather than published: the setting now says do not send, and
    // the rows must not linger to be reconsidered on every future tick.
    if (!settings.enabled || settings.grouping !== "per-repository" || !settings.groupId) {
      await deps.markSent(rows.map(r => r.id));
      continue;
    }
    const topicArn = await deps.topicArnFor(settings.groupId);
    if (!topicArn) { await deps.markSent(rows.map(r => r.id)); continue; }

    const first = rows[0];
    const rendered = buildMessage(settings.subjectTemplate, settings.bodyTemplate, {
      ...first.item,
      org: deps.org,
      state: "ALARM",
      time: formatTimestamp(first.occurredAt, tz),
    });
    const msg = buildDigest(
      rows.map(r => ({ item: r.item, occurredAt: r.occurredAt })),
      rendered, FEED_LABELS[feed], repo,
    );

    if (await deps.publish(topicArn, msg.subject, msg.body)) {
      await deps.markSent(rows.map(r => r.id));
      messages++;
      items += rows.length;
    } else {
      failures++;
    }
  }

  return { items, repos: groups.size, messages, failures };
}
