import { buildMessage, formatTimestamp, sanitizeSubject } from "./message";
import { meetsMinimumSeverity } from "./evaluate";
import { groupBurst, describeBurst, nameAndCount, worstSeverity, type Axis } from "./grouping";

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

/**
 * GitHub's severity vocabulary, translated into this app's.
 *
 * GitHub calls the middle one "moderate"; every threshold here is written as
 * "medium", so an untranslated value ranks below low and clears no floor at
 * all — the alert is silently never emailed.
 *
 * One function because there are two call sites, the buffered path and the
 * immediate one. They were separate copies, and a mutation removing the
 * translation from the buffered path — the default — left the test passing on
 * the strength of the other copy.
 */
export function normalizeSeverity(raw: string | null | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "moderate") return "medium";
  return s || "low";
}

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
  /** What happened, in a phrase: "left-pad across 100 repositories". */
  headline: string,
  /** Where, when the grouping was by subject and the reader cannot infer it. */
  reached?: string,
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
  // Through the same sanitiser every other subject goes through. This one is
  // built here rather than rendered from a template, so it missed it: an
  // organization and repository name together can exceed SNS's 99-character
  // limit, and SNS rejects the publish outright. That failure leaves the rows
  // pending by design, so the effect would be a digest retried every tick
  // forever and never delivered.
  // The customised subject, rendered against the group rather than discarded.
  //
  // This used to be overwritten outright, so anybody who had set a subject to
  // carry a ticket prefix or a mail-filter keyword silently lost it the moment
  // two events arrived together, which is exactly when the email matters most.
  // `rendered.subject` already went through the template with group variables
  // in scope; the count is prefixed because a digest that does not say how many
  // it covers reads as a single event.
  const subject = sanitizeSubject(
    rendered.subject ? `[${n}] ${rendered.subject}` : `[${n}] ${headline}`,
    `${n} new ${n === 1 ? label.singular : label.plural}`,
  );

  // Grouped by subject, the interesting half is which repositories it reached,
  // and every line would otherwise repeat the same package name.
  const lines = reached
    ? sorted.map(({ item }) => {
        const sev = item.severity ? `[${item.severity}] ` : "";
        return `  ${sev}${item.repo ?? "(unknown repository)"}${item.url ? `\n    ${item.url}` : ""}`;
      })
    : sorted.map(({ item }) => {
        const sev = item.severity ? `[${item.severity}] ` : "";
        const what = item.package || item.title || item.number || "(no description)";
        return `  ${sev}${what}${item.url ? `\n    ${item.url}` : ""}`;
      });

  // SNS refuses a message over 256 KB. Enabling Dependabot on a monorepo can
  // raise hundreds of alerts at once, and a truncated list that says so is far
  // better than a publish that fails and retries forever.
  const BODY_MAX = 200_000;
  let shown = lines;
  let omitted = 0;
  while (shown.join("\n").length > BODY_MAX && shown.length > 1) {
    shown = shown.slice(0, Math.floor(shown.length / 2));
    omitted = lines.length - shown.length;
  }

  const body =
    `${headline}\n\n` +
    (reached ? `Repositories: ${reached}\n\n` : "") +
    `${shown.join("\n")}\n` +
    (omitted ? `\n  …and ${omitted} more, not listed to keep this email deliverable.\n` : "") +
    `\n---\n\n${rendered.body}`;

  return { subject, body };
}

export /** Everything the buffer can hold, including the security channel. */
type FeedName = "renovate-pr" | "dependabot-alert" | "security";

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
  "security": { singular: "security alert", plural: "security alerts" },
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

  // Grouped per feed by whichever axis describes the burst, rather than always
  // by repository. One advisory reaching a hundred repositories used to be a
  // hundred emails, each with one line in it; grouped by the advisory it is one.
  // A single repository with thirty findings still groups by the repository,
  // because there the advisory axis is the one that would fragment.
  const byFeed = new Map<FeedName, PendingRow[]>();
  for (const row of pending) {
    const list = byFeed.get(row.feed as FeedName);
    if (list) list.push(row); else byFeed.set(row.feed as FeedName, [row]);
  }

  const groups = new Map<string, { feed: FeedName; axis: Axis; label: string; rows: PendingRow[] }>();
  for (const [feed, rows] of byFeed) {
    const { axis, groups: burst } = groupBurst(rows.map(r => ({
      ...r,
      // What the event is about. The buffered item carries it under different
      // names per feed, so it is normalised here rather than in three callers.
      subject: r.item.package || r.item.title || r.item.message || r.item.widget || r.repo,
    })));
    for (const g of burst) {
      groups.set(`${feed} ${axis} ${g.key}`, {
        feed, axis, label: g.key, rows: g.rows as unknown as PendingRow[],
      });
    }
  }

  let messages = 0, failures = 0, items = 0;
  const tz = await deps.timezone();

  for (const [, group] of groups) {
    const { feed, axis, label, rows } = group;
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
    const repos = [...new Set(rows.map(r => r.repo).filter(Boolean))];
    const what = describeBurst(
      rows.map(r => ({
        repo: r.repo,
        subject: r.item.package || r.item.title || r.item.message || r.item.widget || r.repo,
      })),
      axis, label,
    );
    /**
     * A row-level field, but only where the whole group agrees on it.
     *
     * `{package}` on a digest covering three different packages used to render
     * whichever row happened to be first. That is not wrong so much as
     * arbitrary, and a subject line stating one package when three are affected
     * reads as a fact rather than as a sample. Where the group disagrees, the
     * count is the true answer.
     */
    const agreed = (key: string, plural: string) => {
      const values = [...new Set(rows.map(r => r.item[key]).filter(Boolean))];
      if (values.length === 1) return values[0];
      if (values.length === 0) return undefined;
      return `${values.length} ${plural}`;
    };

    const rendered = buildMessage(settings.subjectTemplate, settings.bodyTemplate, {
      ...first.item,
      package: agreed("package", "packages"),
      title: agreed("title", "pull requests"),
      message: agreed("message", "events"),
      advisory: rows.length === 1 ? first.item.advisory : undefined,
      // Severity is the exception: the worst one, not a count. "3 severities"
      // tells a reader nothing they can act on, and the digest already sorts
      // critical to the top, so the subject naming the worst present is both
      // the useful answer and the one the body already leads with.
      severity: worstSeverity(rows.map(r => r.item.severity)),
      // Describes one alert. On a digest the list above carries every link, and
      // an empty line where a link belongs reads as a broken email, so the
      // template drops the line instead.
      url: rows.length === 1 ? first.item.url : undefined,
      repo: repos.length === 1 ? repos[0] : `${repos.length} repositories`,
      repos: nameAndCount(repos),
      count: String(rows.length),
      what,
      org: deps.org,
      state: "ALARM",
      time: formatTimestamp(first.occurredAt, tz),
    });
    const msg = buildDigest(
      rows.map(r => ({ item: r.item, occurredAt: r.occurredAt })),
      rendered, FEED_LABELS[feed],
      what,
      axis === "subject" ? nameAndCount(rows.map(r => r.repo)) : undefined,
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
