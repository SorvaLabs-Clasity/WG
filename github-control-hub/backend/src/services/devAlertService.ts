import { docClient, tableName, hasTable, GetCommand, PutCommand, DeleteCommand, scanAll } from "../utils/dynamo";

/**
 * Per-developer notifications, to Microsoft Teams.
 *
 * Everything else the app sends is organizational: an alarm the admins set, a
 * reminder the org configured. This is the first thing somebody sets for
 * themselves, about their own work, and that changes what the design has to get
 * right. Nobody is watching it on anybody's behalf, so a delivery that fails
 * silently is a person who simply stops being told and does not find out.
 *
 * Two ways to be told, because they answer different needs and people want
 * both. An **event** fires within seconds of the thing happening, for the
 * handful of moments that are worth interrupting for. A **digest** arrives on a
 * schedule, for the pile you want to work through once a day rather than be
 * pinged about eleven times.
 *
 * Stored in the org-config table under a prefixed key. That table is a
 * key-value store read only by exact key, so per-person rows sit beside the
 * organization's own row without either seeing the other, and it avoids a new
 * table, which would mean a stack deployment before anybody could try this.
 */

const TABLE = () => tableName("ORG_CONFIG_TABLE");

/** The key prefix, so a login can never collide with the org's own row. */
export const KEY_PREFIX = "devalerts#";

export const keyFor = (login: string) => `${KEY_PREFIX}${login.toLowerCase()}`;

/**
 * Which moments are worth interrupting somebody for.
 *
 * Only two, and the limit is not taste. It is what a webhook can actually
 * deliver. "One of yours became mergeable" and "your checks went red" are not
 * single events; they are conclusions drawn from several, and detecting them
 * would mean subscribing to check suites and re-deriving mergeability on every
 * one. Offering them here as switches that quietly never fired would be worse
 * than not offering them, so they live in the digest, where the same facts are
 * read off the snapshot that already exists.
 */
export interface EventPrefs {
  /** Somebody asked you to review something. Arrives from `pull_request`. */
  reviewRequested: boolean;
  /** Somebody asked for changes on one of yours. Needs `pull_request_review`. */
  changesRequested: boolean;
}

export interface DigestPrefs {
  enabled: boolean;
  /** Local hour, 0-23, in `timeZone`. */
  hour: number;
  /**
   * Minutes past that hour, 0-59.
   *
   * The pass ticks every five minutes, so the digest arrives at the first tick
   * at or after the time chosen rather than exactly on it. Offering the minute
   * anyway is the difference between "sometime around nine" and "nine o'clock",
   * and the five-minute lag is stated where the time is picked.
   */
  minute: number;
  timeZone: string;
  /** 0 is Sunday. Empty means every day. */
  days: number[];
  include: {
    toReview: boolean;
    mine: boolean;
    mergeable: boolean;
  };
  /**
   * How far back each section reaches, in days of silence. Zero means no limit.
   *
   * Per section, because sections age differently. Two hundred pull requests
   * nobody has touched in a year push the three from this week into the middle
   * of a list nobody reads to the end of, and a digest that has to be scrolled
   * gets ignored, which costs more than the omission.
   *
   * Measured from the last commit, so something touched this morning is not
   * stale however long ago it was opened. Absent means no limit.
   */
  maxAgeDays: {
    toReview: number;
    mine: number;
    mergeable: number;
  };
  /**
   * A digest with nothing in it is how a channel gets muted.
   *
   * On by default for that reason: somebody who wants the daily "all clear" can
   * ask for it, and everybody else is not trained to ignore the message.
   */
  skipWhenEmpty: boolean;
}

export interface DevAlerts {
  /** The table's key. Always `keyFor(login)`. */
  org: string;
  login: string;
  /**
   * Where to DM this person in Teams: their work email address.
   *
   * Not a webhook. The organization has one shared flow and the destination
   * travels with each message, so what a person supplies is who they are, not
   * a pipe of their own. One field, once, instead of a Power Automate setup
   * each.
   *
   * Kept separate from any GitHub email on purpose: a GitHub account often
   * carries a private or `users.noreply.github.com` address, and neither is
   * where Teams would find somebody.
   */
  teamsAddress?: string;
  events: EventPrefs;
  digest: DigestPrefs;
  /**
   * When a digest was last sent, so the five-minute tick can tell "due now"
   * from "already sent this morning". Without it every tick inside the chosen
   * hour would send another copy.
   */
  lastDigestAt?: string;
  /**
   * The last delivery failure, kept so the settings screen can show it.
   *
   * A webhook URL that is subtly wrong fails silently and forever, and the
   * person it belongs to has no way to notice. Recording it is what turns that
   * into something visible.
   */
  lastError?: string;
  lastErrorAt?: string;
  lastSentAt?: string;
  updatedAt: string;
}

export function defaults(login: string): DevAlerts {
  return {
    org: keyFor(login),
    login,
    events: {
      reviewRequested: true,
      changesRequested: true,
    },
    digest: {
      enabled: false,
      hour: 9,
      minute: 0,
      timeZone: "America/New_York",
      days: [1, 2, 3, 4, 5],
      include: { toReview: true, mine: true, mergeable: true },
      // No limit by default: a summary that silently omits things somebody
      // never asked it to omit is worse than a long one.
      maxAgeDays: { toReview: 0, mine: 0, mergeable: 0 },
      skipWhenEmpty: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Only a Teams webhook, and only over TLS.
 *
 * This URL is posted to by a Lambda with no further checks, so anything
 * accepted here is somewhere the app will send pull request titles. Restricting
 * it to Microsoft's own hosts is what stops it being a way to make the app POST
 * to an arbitrary address.
 */
/**
 * The Microsoft hosts a Teams webhook can legitimately live on.
 *
 * There is no single one, because the feature has moved twice. The retired
 * Office 365 connector issued `webhook.office.com`; Power Automate flows have
 * historically been on `logic.azure.com`; and current Power Platform
 * environments issue `…environment.api.powerplatform.com`. All three are in
 * use simultaneously depending on when and where the workflow was created, so
 * a list that names only the older two rejects perfectly valid URLs, which is
 * exactly what it did.
 *
 * Anchored at both ends and matching whole labels, so `powerplatform.com` in
 * the middle of somebody else's hostname does not pass.
 */
const TEAMS_HOSTS = /^([a-z0-9-]+\.)*(webhook\.office\.com|logic\.azure\.com|powerplatform\.com|flow\.microsoft\.com|azure\.com)$/i;

/** Named in the refusal, so somebody can tell whether their URL should work. */
const ACCEPTED = "webhook.office.com, logic.azure.com, powerplatform.com or flow.microsoft.com";

/**
 * A Teams address is an email address, so it is checked as one.
 *
 * Deliberately loose beyond that. Which addresses actually reach somebody in
 * Teams is a question only the tenant can answer, and a stricter pattern here
 * would refuse valid ones while catching nothing a typo produces.
 */
export function badTeamsAddress(value: string): string | null {
  const v = value.trim();
  if (!v) return "An address is required.";
  if (v.length > 200) return "That address is too long.";
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) {
    return "That does not look like an email address. Use the work address this person signs in to Teams with.";
  }
  return null;
}

export function badWebhook(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "That does not look like a URL.";
  }
  if (parsed.protocol !== "https:") return "The webhook must be an https URL.";
  if (!TEAMS_HOSTS.test(parsed.hostname)) {
    return `That host is not one Microsoft issues Teams webhooks on. It should end in ${ACCEPTED}, `
      + `and yours is "${parsed.hostname}". Copy the URL from the Workflows connector in Teams. `
      + "If that is where this came from, it is a host the app has not been told about.";
  }
  return null;
}

export async function getDevAlerts(login: string): Promise<DevAlerts> {
  if (!hasTable("ORG_CONFIG_TABLE")) return defaults(login);
  const out = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { org: keyFor(login) } }));
  // Merged onto the defaults rather than returned raw: a row written before a
  // preference existed has no value for it, and `undefined` in a checkbox reads
  // as off when the default is on.
  const stored = out.Item as Partial<DevAlerts> | undefined;
  if (!stored) return defaults(login);
  const base = defaults(login);
  return {
    ...base,
    ...stored,
    org: base.org,
    login,
    events: { ...base.events, ...stored.events },
    digest: {
      ...base.digest,
      ...stored.digest,
      include: { ...base.digest.include, ...stored.digest?.include },
      maxAgeDays: { ...base.digest.maxAgeDays, ...stored.digest?.maxAgeDays },
    },
  } as DevAlerts;
}

export async function putDevAlerts(alerts: DevAlerts): Promise<DevAlerts> {
  const row: DevAlerts = { ...alerts, org: keyFor(alerts.login), updatedAt: new Date().toISOString() };
  if (hasTable("ORG_CONFIG_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: row }));
  }
  return row;
}

export async function deleteDevAlerts(login: string): Promise<void> {
  if (!hasTable("ORG_CONFIG_TABLE")) return;
  await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { org: keyFor(login) } }));
}

/**
 * Everybody who has configured anything.
 *
 * A scan, and the only one this table has. It holds one row per person plus the
 * organization's own, so this is a single request on any realistic
 * organization, and the alternative, an index, would be a stack change for a
 * table with tens of rows in it.
 */
export async function listDevAlerts(): Promise<DevAlerts[]> {
  if (!hasTable("ORG_CONFIG_TABLE")) return [];
  const rows = await scanAll<any>(TABLE());
  return rows.filter(r => typeof r?.org === "string" && r.org.startsWith(KEY_PREFIX)) as DevAlerts[];
}

// ── when a digest is due ──────────────────────────────────────────────

/**
 * The local hour and weekday for a person, wherever they are.
 *
 * A digest set for nine in the morning has to arrive at nine in *their*
 * morning, and the pass deciding that runs in UTC. An unknown zone falls back
 * to UTC rather than throwing: a bad timezone string should send the digest at
 * an odd hour, not stop sending it.
 */
export function localNow(now: number, timeZone: string): { hour: number; minute: number; day: number; date: string } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit", hour12: false, weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC", hour: "numeric", minute: "2-digit", hour12: false, weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    // "24" is midnight in this format, and reading it as hour 24 would mean a
    // digest set for midnight never matched.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute) || 0,
    day: DAYS.indexOf(String(parts.weekday)),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/**
 * Whether this person's digest should go out on this tick.
 *
 * The pass runs every five minutes, so the hour matches twelve times over. What
 * stops twelve copies is the last-sent date: one per local calendar day, and
 * the comparison is on their date rather than on elapsed hours so a clock
 * change cannot produce two.
 */
/** How long after the chosen time a digest may still go out. */
export const LATE_WINDOW_MINUTES = 60;

/**
 * Why a digest is not going out, in a word.
 *
 * `digestDue` answers yes or no, which is all the pass needs and nothing like
 * enough to debug with: a tick where nobody is due logs nothing, and that looks
 * exactly like the pass not running at all. Every one of these has been the
 * real cause at least once.
 */
export function whyNotDue(a: DevAlerts, now: number): string | null {
  if (!a.digest.enabled) return "disabled";
  if (!a.teamsAddress) return "no address";
  const { hour, minute, day, date } = localNow(now, a.digest.timeZone);
  if (a.digest.days.length > 0 && !a.digest.days.includes(day)) return "not a chosen day";
  const late = (hour * 60 + minute) - (a.digest.hour * 60 + (a.digest.minute ?? 0));
  if (late < 0) return "not yet";
  if (late >= LATE_WINDOW_MINUTES) return "window passed";
  if (a.lastDigestAt
      && localNow(Date.parse(a.lastDigestAt), a.digest.timeZone).date === date) {
    return "already sent today";
  }
  return null;
}

/**
 * At or after the chosen time, not exactly on it: the pass ticks every five
 * minutes, so an exact match would mean 9:58 never fires.
 *
 * Bounded by an hour, so a pass that could not run at nine still delivers at
 * half past but never at eleven at night.
 *
 * Defined as "no reason not to", so the decision and its explanation cannot
 * drift into two rules that disagree.
 */
/**
 * What `lastDigestAt` becomes when somebody saves their settings.
 *
 * Changing when the summary arrives re-decides whether today's is still owed:
 * a time still ahead clears the record so it can arrive today, and one already
 * past is marked done so it waits for tomorrow. Setting 12:45 at 12:48 means
 * tomorrow, not in two minutes.
 *
 * Only the timing counts. Toggling a section in the evening changes what
 * tomorrow's says, not whether tonight gets a second one.
 */
export function nextDigestRecord(current: DevAlerts, next: DevAlerts, now = Date.now()): string | undefined {
  const rescheduled = next.digest.hour !== current.digest.hour
    || next.digest.minute !== current.digest.minute
    // The zone moves the schedule as surely as the clock does. 2:10pm is a
    // different moment in a different zone, and leaving this out meant setting
    // a time and then correcting the zone lost that day's summary: the time was
    // saved first, judged against the old zone where it had already gone by,
    // and marked done for the day. Changing the zone afterwards was not
    // counted as a reschedule, so the record stood, and the moment it named
    // came and went with nothing sent.
    || next.digest.timeZone !== current.digest.timeZone
    || (next.digest.enabled && !current.digest.enabled);
  if (!rescheduled) return current.lastDigestAt;

  const local = localNow(now, next.digest.timeZone);
  const chosen = next.digest.hour * 60 + (next.digest.minute ?? 0);
  const passed = local.hour * 60 + local.minute >= chosen;
  return passed ? new Date(now).toISOString() : undefined;
}

export function digestDue(a: DevAlerts, now: number): boolean {
  return whyNotDue(a, now) === null;
}
