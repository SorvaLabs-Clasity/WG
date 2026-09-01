import crypto from "crypto";

import { logActivity } from "./activityService";
import { docClient, hasTable, tableName, PutCommand, ScanCommand, GetCommand, DeleteCommand, UpdateCommand, scanAll } from "../utils/dynamo";
import type { AlarmCondition, AlarmState, Severity } from "../alarms/conditions";
import {
  DEFAULT_ALARM_SUBJECT, DEFAULT_ALARM_BODY,
  DEFAULT_EACH_SUBJECT, DEFAULT_EACH_BODY,
  DEFAULT_SECURITY_SUBJECT, DEFAULT_SECURITY_BODY,
  DEFAULT_RENOVATE_SUBJECT, DEFAULT_RENOVATE_BODY,
  DEFAULT_DEPENDABOT_SUBJECT, DEFAULT_DEPENDABOT_BODY,
} from "../alarms/message";
import { sameValue } from "../utils/sameValue";

/**
 * Alarms, the email groups they notify, and the security-alert toggle.
 *
 * All three live in one table keyed by id and told apart by `kind`, the same
 * shape the alerts and widgets tables use. Alarm runtime state, whether it is
 * currently firing, how many clean checks it has seen, is stored on the alarm
 * itself rather than beside it, because an alarm and its state are read and
 * written together on every evaluation and splitting them would buy a second
 * round trip and a chance to disagree.
 */

export type AlarmRecordKind = "alarm" | "group" | "security";

export interface WidgetAlarm {
  id: string;
  kind: "alarm";
  widgetId: string;
  /** Shown in the UI and in the email. Defaults to the widget's title. */
  name: string;
  condition: AlarmCondition;
  groupId: string;
  subjectTemplate: string;
  bodyTemplate: string;
  /**
   * The Teams wording, when it should differ from the email above.
   *
   * Empty means "use the email one", which is what every alarm written before
   * this field existed means, and keeps one message to maintain for anybody
   * who does not want two.
   *
   * They are separate because the two are read differently: an email is opened
   * deliberately and gets a paragraph, a Teams message is glanced at in a
   * sidebar and wants a line.
   */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  notifyOnRecovery: boolean;
  enabled: boolean;
  /**
   * Whose alarm this is, if anybody's.
   *
   * Absent means the organization's, so every alarm written before this needs
   * no migration. Set means it watches that person's own widget, notifies their
   * own group, and only they can see or change it — including administrators,
   * who have no more business reading somebody's private alerts than
   * rearranging their dashboard.
   */
  owner?: string;

  // ── runtime, written by the evaluator ──
  state: AlarmState;
  cleanStreak: number;
  /**
   * For an "each" alarm: the rows it has already reported.
   *
   * Bounded, and rewritten each time it speaks rather than accumulated: a
   * finding that is fixed and then returns is worth hearing about again, and
   * remembering it for ever would swallow the recurrence.
   */
  seenKeys?: string[];
  lastCheckedAt?: string;
  lastValue?: number | null;
  lastFiredAt?: string;
  /** Set when an evaluation could not read a value, so the UI can say so. */
  lastError?: string;

  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailGroup {
  id: string;
  kind: "group";
  name: string;
  /** The SNS topic behind this group. */
  topicArn: string;
  /**
   * People this group also DMs in Teams, by work email address.
   *
   * Addresses rather than webhooks: the organization has one shared flow and
   * the destination travels with each message, so adding somebody is typing who
   * they are, exactly like the email column beside it, rather than asking them
   * to build a pipe of their own first.
   */
  teamsRecipients?: string[];
  /**
   * The zone each Teams recipient reads their times in, by address.
   *
   * A map beside the list rather than a field on it, so `teamsRecipients` stays
   * the array of strings every stored group already holds and no row has to be
   * migrated. An address missing from here falls back to the group's zone.
   *
   * Only Teams. Email leaves through one SNS publish to one topic, which
   * delivers the same body to every subscriber, so there is no per-person text
   * to put a per-person time in. `timeZone` below is the honest granularity
   * for that half.
   */
  recipientZones?: Record<string, string>;
  /**
   * The zone this group's email is written in, and the default for its people.
   * Unset means the organization's zone.
   */
  timeZone?: string;
  /**
   * Addresses whose pending invitation was cancelled.
   *
   * AWS offers no way to withdraw a subscription that has not been confirmed:
   * it has no ARN to unsubscribe, and it simply expires after three days. So
   * the X on an unconfirmed row did nothing at all, reported success, and left
   * the person sitting in the list.
   *
   * Recorded here instead, and acted on in two places: the row disappears at
   * once, and if that person confirms later, the subscription that appears is
   * unsubscribed rather than quietly starting to deliver to somebody who was
   * removed. Without the second half this list would be a lie by three days.
   */
  revokedPending?: string[];
  /**
   * Whose group this is, if anybody's.
   *
   * One per person, made on demand, and never offered in the group list an
   * administrator manages: it is where that person's own alarms go, not an
   * organization destination somebody else can point an alarm at.
   */
  owner?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where one person's own alarms are delivered.
 *
 * One group each, created the first time they need it, so every piece of
 * delivery machinery the organization's alarms already use — the SNS topic, the
 * Teams recipients, the per-person timezones, the templates — works unchanged
 * for a personal alarm. The alternative was a second delivery path beside the
 * tested one, which is how two ways of sending an email end up disagreeing
 * about what a message looks like.
 *
 * The person never picks it. A personal alarm's group is resolved from who is
 * asking, never from the request body, so this cannot become a way to point an
 * alarm at somebody else's inbox or at an organization topic.
 */
export async function getOrCreatePersonalGroup(login: string): Promise<EmailGroup> {
  const mine = (await listGroups()).find(
    g => g.owner && g.owner.toLowerCase() === login.toLowerCase());
  if (mine) return mine;

  const { createTopic } = await import("./notifyService");
  const name = `${login}'s alarms`;
  const topicArn = await createTopic(`personal-${login}`);
  return createGroupRecord(name, topicArn, login, login);
}

/** The groups an administrator manages: the organization's, never anybody's own. */
export async function listOrgGroups(): Promise<EmailGroup[]> {
  return (await listGroups()).filter(g => !g.owner);
}

/** One person's own alarms. */
export async function listPersonalAlarms(login: string): Promise<WidgetAlarm[]> {
  return (await listAlarms()).filter(
    a => a.owner && a.owner.toLowerCase() === login.toLowerCase());
}

/** The organization's alarms: everything nobody owns personally. */
export async function listOrgAlarms(): Promise<WidgetAlarm[]> {
  return (await listAlarms()).filter(a => !a.owner);
}

/** One row, because there is one security-alert setting for the organization. */
export const SECURITY_SETTINGS_ID = "security-settings";

export interface SecurityNotifySettings {
  id: typeof SECURITY_SETTINGS_ID;
  kind: "security";
  enabled: boolean;
  groupId?: string;
  /** Alerts below this are recorded but not emailed. */
  minSeverity: Severity;
  subjectTemplate: string;
  bodyTemplate: string;
  /**
   * The Teams wording, when it should differ from the email above.
   *
   * Empty means "use the email one", which is what every alarm written before
   * this field existed means, and keeps one message to maintain for anybody
   * who does not want two.
   *
   * They are separate because the two are read differently: an email is opened
   * deliberately and gets a paragraph, a Teams message is glanced at in a
   * sidebar and wants a line.
   */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  /**
   * IANA zone the {{time}} variable is rendered in, for both alarm and
   * security emails. UTC by default, because one email reaches a group who may
   * be anywhere; set it when everyone reading them is in one place.
   */
  timezone: string;
  updatedBy?: string;
  updatedAt?: string;
}

/**
 * The last pull request list, stored so opening the tab does not wait for it.
 *
 * The list is the slowest read this app makes: GitHub's search API is walked a
 * page at a time and a large organization is several seconds per page. It was
 * fetched fresh on every load, so every launch had that wait in it, and the
 * scheduled pass was already fetching the same thing every five minutes and
 * discarding it.
 *
 * Stored as one JSON string rather than as attributes, because the shape is the
 * route's response and pinning it here would mean two definitions of the same
 * rows drifting apart.
 */
export interface PrSnapshot {
  id: "pr-snapshot";
  kind: "pr-snapshot";
  /** JSON of `{ prs, truncated }`, exactly as fetchOpenPrs returned it. */
  payload: string;
  /** When the walk that produced this finished. */
  cachedAt: string;
  /** How many pull requests it holds, so the size guard has something to report. */
  count: number;
  ttl: number;
}

type AnyRecord = WidgetAlarm | EmailGroup | SecurityNotifySettings | FeedNotifySettings | PendingNotification | PrState | PrFeatureSettings | PrMutes | PrSnapshot | WidgetSnapshot;

const TABLE = () => tableName("ALARMS_TABLE");

/** In-memory fallback for local development, as the other services do. */
let memStore: AnyRecord[] = [];

async function allRecords(): Promise<AnyRecord[]> {
  if (hasTable("ALARMS_TABLE")) {
    // Paged, and filtered server-side.
    //
    // Paged because a single scan stops at 1MB without saying so, and every
    // caller of this reads something that must not silently shrink: the alarms
    // to evaluate, the email groups to send to, the notifications waiting to go
    // out, and the pull request rows holding mutes and pauses.
    //
    // Filtered because the security checks keep one cached verdict per account
    // or repository in this same table, which on a large organization is
    // hundreds of rows none of these callers want. Excluding them server-side
    // keeps an alarm pass from paging through a cache it never reads.
    return await scanAll<AnyRecord>(TABLE(), {
      filter: "attribute_not_exists(#k) OR #k <> :cache",
      names: { "#k": "kind" },
      values: { ":cache": "query-subject" },
    });
  }
  return memStore;
}

async function put(record: AnyRecord): Promise<void> {
  if (hasTable("ALARMS_TABLE")) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: record }));
    return;
  }
  const i = memStore.findIndex(r => r.id === record.id);
  if (i >= 0) memStore[i] = record;
  else memStore.push(record);
}

async function getById<T extends AnyRecord>(id: string): Promise<T | undefined> {
  if (hasTable("ALARMS_TABLE")) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as T | undefined;
  }
  return memStore.find(r => r.id === id) as T | undefined;
}

// ── alarms ────────────────────────────────────────────────────────────

export async function listAlarms(): Promise<WidgetAlarm[]> {
  return (await allRecords()).filter(r => r.kind === "alarm") as WidgetAlarm[];
}

export async function listAlarmsForWidget(widgetId: string): Promise<WidgetAlarm[]> {
  return (await listAlarms()).filter(a => a.widgetId === widgetId);
}

export async function getAlarm(id: string): Promise<WidgetAlarm | undefined> {
  const found = await getById<WidgetAlarm>(id);
  return found?.kind === "alarm" ? found : undefined;
}

export async function createAlarm(
  data: {
    widgetId: string; name: string; condition: AlarmCondition; groupId: string;
    subjectTemplate?: string; bodyTemplate?: string;
    teamsSubjectTemplate?: string; teamsBodyTemplate?: string;
    notifyOnRecovery?: boolean; enabled?: boolean;
    /** Set only by the personal route, from the session, never from a body. */
    owner?: string;
  },
  actor: string,
): Promise<WidgetAlarm> {
  const now = new Date().toISOString();
  const alarm: WidgetAlarm = {
    id: crypto.randomUUID(),
    kind: "alarm",
    widgetId: data.widgetId,
    name: data.name,
    condition: data.condition,
    groupId: data.groupId,
    ...(data.owner ? { owner: data.owner } : {}),
    // The wording follows the kind of alarm. A threshold template on an alarm
    // with no threshold ends "your limit is undefined", which is how somebody
    // first noticed the two did not match.
    subjectTemplate: data.subjectTemplate
      || (data.condition?.kind === "each" ? DEFAULT_EACH_SUBJECT : DEFAULT_ALARM_SUBJECT),
    bodyTemplate: data.bodyTemplate
      || (data.condition?.kind === "each" ? DEFAULT_EACH_BODY : DEFAULT_ALARM_BODY),
    // No default. Empty is meaningful here: it means the email wording, and
    // filling it in would make every alarm carry two copies of the same text
    // that then drift apart.
    teamsSubjectTemplate: data.teamsSubjectTemplate ?? "",
    teamsBodyTemplate: data.teamsBodyTemplate ?? "",
    notifyOnRecovery: data.notifyOnRecovery ?? true,
    enabled: data.enabled ?? true,
    // A new alarm starts clear. Starting it in ALARM would email everyone the
    // first time the evaluator ran, before anything had actually changed.
    state: "OK",
    cleanStreak: 0,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  await put(alarm);
  await logActivity(
    "config.updated" as any, actor, "", "alarm",
    `Created alarm "${alarm.name}"`, { alarmId: alarm.id, widgetId: alarm.widgetId }, "app",
    undefined, undefined, { personal: !!alarm.owner },
  );
  return alarm;
}

/**
 * The fields a person may change on an alarm.
 *
 * Enforced at run time, not only in the type. The route hands `req.body`
 * straight to this function, and the loop below copied every key it found,
 * so the type said "these seven fields" and the code said "anything you send".
 *
 * That is not only untidy. Alarms, email groups, the security toggle, the feed
 * settings, the buffered notifications and the pull request state all live in
 * one table keyed on `id`, told apart by `kind`. A body carrying its own `id`
 * therefore wrote the *edited alarm* over whatever else held that id: sending
 * `{"id": "security-settings"}` replaces the organization's security-alert
 * configuration, and sending an email group's id replaces the group, including
 * its `topicArn`, which is the address every alarm publishes to.
 *
 * `saveSecuritySettings` and `saveFeedSettings` in this same file already got
 * this right by pinning `id` and `kind` after the spread. This is the same
 * rule, expressed as an allow-list because an alarm has more mutable fields
 * than they do.
 */
const EDITABLE_ALARM_FIELDS = [
  "name", "condition", "groupId", "subjectTemplate",
  "bodyTemplate", "teamsSubjectTemplate", "teamsBodyTemplate",
  "notifyOnRecovery", "enabled",
] as const;

type EditableAlarm = Partial<Pick<WidgetAlarm, typeof EDITABLE_ALARM_FIELDS[number]>>;

/** Only the fields above, so nothing else can ride in on a request body. */
export function pickAlarmEdits(data: Record<string, unknown>): EditableAlarm {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_ALARM_FIELDS) {
    if (data?.[key] !== undefined) out[key] = data[key];
  }
  return out as EditableAlarm;
}

export async function updateAlarm(
  id: string,
  raw: Record<string, unknown>,
  actor: string,
): Promise<WidgetAlarm | null> {
  const existing = await getAlarm(id);
  if (!existing) return null;

  const data = pickAlarmEdits(raw);

  const updated: WidgetAlarm = { ...existing, updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) (updated as any)[k] = v;
  }
  // Belt as well as braces: whatever the allow-list let through, this row is
  // still this alarm.
  updated.id = existing.id;
  updated.kind = "alarm";

  // Changing what an alarm watches makes its stored state meaningless: an
  // alarm firing on "critical >= 1" that becomes "total >= 500" would stay in
  // ALARM and never send the email for the new condition, because the first
  // breach it sees is not a transition.
  //
  // Compared structurally, never as JSON text. DynamoDB returns a map's keys in
  // its own order, so the condition read back was `{kind, threshold, metric,
  // op}` where the form sends `{kind, metric, op, threshold}`, identical
  // conditions, different strings. Every save of any field therefore looked
  // like a condition change, reset a firing alarm to OK, and made the next
  // evaluation a fresh breach that emailed everybody again. Renaming an alarm
  // or fixing a typo in its email body was enough to do it.
  const conditionChanged = data.condition !== undefined
    && !sameValue(data.condition, existing.condition);
  if (conditionChanged) {
    updated.state = "OK";
    updated.cleanStreak = 0;
    delete updated.lastValue;
    delete updated.lastError;
  }

  await put(updated);
  const changes = describeChanges(existing, updated, [
    ["name", "renamed"],
    ["enabled", "alarm"],
    ["groupId", "email group"],
    ["notifyOnRecovery", "recovery email"],
    ["subjectTemplate", "subject template edited"],
    ["bodyTemplate", "body template edited"],
    ["teamsSubjectTemplate", "Teams subject template edited"],
    ["teamsBodyTemplate", "Teams body template edited"],
  ]);
  if (conditionChanged) changes.unshift("condition changed");
  await logActivity(
    "config.updated" as any, actor, "", "alarm",
    changes.length
      ? `Alarm "${updated.name}": ${changes.join(", ")}`
      : `Alarm "${updated.name}" saved with no change`,
    { alarmId: id, conditionChanged, changed: changes }, "app",
    undefined, undefined, { personal: !!updated.owner },
  );
  return updated;
}

/** Written by the evaluator. Never touches the user's configuration fields. */
/**
 * Take ownership of one state change, so exactly one sender acts on it.
 *
 * Returns true if this caller moved the alarm from `from` to `to`, and false if
 * somebody else already did.
 *
 * The evaluator publishes and *then* records the new state, so two passes
 * reading the same `OK` both see the breach and both send. That is reachable
 * today with one evaluator: the pass has a five-minute timeout on a
 * five-minute schedule, so an overrun overlaps the next run. It becomes
 * ordinary rather than rare as soon as anything else may evaluate an alarm,
 * which is the point of triggering on data changes.
 *
 * A conditional update is the whole mechanism: DynamoDB applies it only if the
 * state is still what this caller read, so the loser is told no and stays
 * quiet. The claim is taken *before* the message goes out, because a claim
 * checked afterwards can only report a duplicate that has already been sent.
 *
 * Without the table, the in-memory store is single-process and cannot race.
 */
/**
 * Record the rows an "each" alarm has reported, and say whether we won.
 *
 * `claimTransition` guards a state change, which is the wrong thing to guard
 * here: this kind of alarm commonly speaks while already in ALARM, where there
 * is no state change for two passes to compete over. What they would race on is
 * the remembered set, so that is what is claimed — conditionally on it still
 * holding what we read, so exactly one caller reports a given batch.
 */
/** Two remembered sets, compared as lists rather than as text. */
function sameKeys(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((k, i) => k === b[i]);
}

export async function claimSeen(
  id: string, from: string[] | undefined, to: string[], at: string,
): Promise<boolean> {
  if (!hasTable("ALARMS_TABLE")) {
    const i = memStore.findIndex(r => r.id === id);
    if (i < 0) return false;
    const existing = memStore[i] as any;
    // Element by element, not as JSON text. Stringifying to decide whether
    // something changed is how a re-ordered object once produced an email
    // about nothing, and `sameKeys` is the same comparison the stored path
    // asks DynamoDB to make.
    if (!sameKeys(existing.seenKeys, from)) return false;
    memStore[i] = { ...existing, seenKeys: to, lastFiredAt: at };
    return true;
  }
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(), Key: { id },
      UpdateExpression: "SET seenKeys = :to, lastFiredAt = :at",
      // `attribute_not_exists` covers the first time it ever speaks, when there
      // is nothing stored to compare against.
      ConditionExpression: from === undefined
        ? "attribute_exists(id) AND attribute_not_exists(seenKeys)"
        : "attribute_exists(id) AND seenKeys = :from",
      ExpressionAttributeValues: {
        ":to": to, ":at": at,
        ...(from === undefined ? {} : { ":from": from }),
      },
    }));
    return true;
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function claimTransition(
  id: string, from: AlarmState, to: AlarmState, at: string,
): Promise<boolean> {
  if (!hasTable("ALARMS_TABLE")) {
    const row = memStore.find(r => r.id === id) as WidgetAlarm | undefined;
    if (!row || row.state !== from) return false;
    row.state = to;
    row.lastFiredAt = at;
    return true;
  }
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE(),
      Key: { id },
      UpdateExpression: "SET #s = :to, lastFiredAt = :at",
      // The alarm must still exist and still be in the state this caller based
      // its decision on.
      ConditionExpression: "attribute_exists(id) AND #s = :from",
      ExpressionAttributeNames: { "#s": "state" },
      ExpressionAttributeValues: { ":to": to, ":from": from, ":at": at },
    }));
    return true;
  } catch (err: any) {
    // Somebody else got there first, which is the answer this exists to give
    // and not a failure.
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

export async function saveAlarmRuntime(
  id: string,
  runtime: { state: AlarmState; cleanStreak: number; lastCheckedAt: string;
             lastValue?: number | null; lastFiredAt?: string; lastError?: string;
             seenKeys?: string[] },
): Promise<void> {
  const existing = await getAlarm(id);
  if (!existing) return;
  const updated: WidgetAlarm = { ...existing, ...runtime };
  if (runtime.lastError === undefined) delete updated.lastError;
  await put(updated);
}

export async function deleteAlarm(id: string, actor: string): Promise<boolean> {
  const existing = await getAlarm(id);
  if (!existing) return false;
  if (hasTable("ALARMS_TABLE")) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memStore = memStore.filter(r => r.id !== id);
  }
  await logActivity(
    "config.updated" as any, actor, "", "alarm",
    `Deleted alarm "${existing.name}"`, { alarmId: id }, "app",
    undefined, undefined, { personal: !!existing.owner },
  );
  return true;
}

// ── email groups ──────────────────────────────────────────────────────

export async function listGroups(): Promise<EmailGroup[]> {
  return (await allRecords()).filter(r => r.kind === "group") as EmailGroup[];
}

/**
 * The group behind an SNS topic.
 *
 * `publish` is handed a topic ARN and nothing else. It is the seam every
 * notification in the app passes through, and it predates there being more than
 * one way to deliver. This is how it finds the rest of the group's channels.
 */
export async function groupByTopic(topicArn: string): Promise<EmailGroup | undefined> {
  return (await listGroups()).find(g => g.topicArn === topicArn);
}

export async function getGroup(id: string): Promise<EmailGroup | undefined> {
  const found = await getById<EmailGroup>(id);
  return found?.kind === "group" ? found : undefined;
}

export async function saveGroup(group: EmailGroup): Promise<void> {
  await put(group);
}

export async function createGroupRecord(
  name: string, topicArn: string, actor: string, owner?: string,
): Promise<EmailGroup> {
  const now = new Date().toISOString();
  const group: EmailGroup = {
    id: crypto.randomUUID(), kind: "group", name, topicArn,
    ...(owner ? { owner } : {}),
    createdBy: actor, createdAt: now, updatedAt: now,
  };
  await put(group);
  await logActivity(
    "config.updated" as any, actor, "", "alarm_group",
    owner
      ? `Set up where "${actor}" receives their own alarms`
      : `Created email group "${name}"`,
    { groupId: group.id, topicArn }, "app",
    undefined, undefined, { personal: !!owner },
  );
  return group;
}

export async function deleteGroupRecord(id: string, actor: string): Promise<EmailGroup | null> {
  const existing = await getGroup(id);
  if (!existing) return null;
  if (hasTable("ALARMS_TABLE")) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memStore = memStore.filter(r => r.id !== id);
  }
  await logActivity(
    "config.updated" as any, actor, "", "alarm_group",
    `Deleted email group "${existing.name}"`, { groupId: id }, "app",
  );
  return existing;
}

/** Alarms pointing at a group, so deleting one can say what it would break. */
export async function alarmsUsingGroup(groupId: string): Promise<WidgetAlarm[]> {
  return (await listAlarms()).filter(a => a.groupId === groupId);
}

// ── the security-alert toggle ─────────────────────────────────────────

export const DEFAULT_SECURITY_SETTINGS: SecurityNotifySettings = {
  id: SECURITY_SETTINGS_ID,
  kind: "security",
  // Off until somebody turns it on. Enabling it by default would start
  // emailing whoever happened to be in a group the moment they created one.
  enabled: false,
  minSeverity: "high",
  timezone: "UTC",
  subjectTemplate: DEFAULT_SECURITY_SUBJECT,
  bodyTemplate: DEFAULT_SECURITY_BODY,
};

/**
 * What actually changed, for the activity row.
 *
 * Every save wrote the same sentence, "Security alert emails enabled (high and
 * above)", whether somebody toggled it, moved the severity floor or rewrote the
 * email body. Editing a template produced a row indistinguishable from the row
 * before it, which reads as the change not having been recorded at all.
 *
 * Templates are reported as changed, never quoted: a body is several lines and
 * belongs in the record of the setting, not in a one-line feed entry.
 */
function describeChanges(
  before: Record<string, any>,
  after: Record<string, any>,
  fields: Array<[string, string]>,
): string[] {
  const changed: string[] = [];
  for (const [key, label] of fields) {
    if (after[key] === undefined) continue;
    if (sameValue(before[key], after[key])) continue;
    if (key === "subjectTemplate" || key === "bodyTemplate"
      || key === "teamsSubjectTemplate" || key === "teamsBodyTemplate") changed.push(label);
    else if (typeof after[key] === "boolean") changed.push(`${label} ${after[key] ? "on" : "off"}`);
    else changed.push(`${label} → ${after[key]}`);
  }
  return changed;
}

export async function getSecuritySettings(): Promise<SecurityNotifySettings> {
  const found = await getById<SecurityNotifySettings>(SECURITY_SETTINGS_ID);
  if (found?.kind === "security") return { ...DEFAULT_SECURITY_SETTINGS, ...found };
  return { ...DEFAULT_SECURITY_SETTINGS };
}

export async function saveSecuritySettings(
  data: Partial<Pick<SecurityNotifySettings, "enabled" | "groupId" | "minSeverity"
    | "subjectTemplate" | "bodyTemplate"
    | "teamsSubjectTemplate" | "teamsBodyTemplate" | "timezone">>,
  actor: string,
): Promise<SecurityNotifySettings> {
  const current = await getSecuritySettings();
  const updated: SecurityNotifySettings = {
    ...current,
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    id: SECURITY_SETTINGS_ID,
    kind: "security",
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  await put(updated);
  const changes = describeChanges(current, updated, [
    ["enabled", "Important event emails"],
    ["groupId", "email group"],
    ["minSeverity", "severity floor"],
    ["timezone", "timezone"],
    ["subjectTemplate", "subject template edited"],
    ["bodyTemplate", "body template edited"],
    ["teamsSubjectTemplate", "Teams subject template edited"],
    ["teamsBodyTemplate", "Teams body template edited"],
  ]);
  await logActivity(
    "config.updated" as any, actor, "", "alarm_security",
    changes.length
      ? `Important events: ${changes.join(", ")}`
      // Saved with nothing different. Still recorded, because "somebody opened
      // this and pressed save" is itself worth seeing in an audit trail.
      : "Important event settings saved with no change",
    { enabled: updated.enabled, minSeverity: updated.minSeverity, changed: changes }, "app",
  );
  return updated;
}

// ── per-event notifications for the Vulnerabilities tab ───────────────
//
// The security toggle emails when an alert is *recorded*; these two email when
// GitHub tells us something happened, which is the same shape and deliberately
// the same code. One row per feed, like the security one, because there is one
// setting per organization rather than one per repository.
//
// Kept separate from alarms on purpose. An alarm watches a number and fires
// when it crosses a line; these fire once per event and never resolve. Reusing
// the alarm machinery would mean inventing a threshold and a recovery for
// something that has neither.

export type NotifyFeed = "renovate-pr" | "dependabot-alert";

/**
 * What the pending buffer can hold.
 *
 * Wider than NotifyFeed, and deliberately a separate type. Security alerts are
 * buffered so a burst can be grouped the way Dependabot findings already were,
 * but they have no feed settings row: the security tab's own toggle and
 * severity floor decide whether an alert is buffered at all, and by the time it
 * reaches the buffer that decision is behind it. Folding it into NotifyFeed
 * would have demanded templates and a grouping mode that mean nothing here.
 */
export type BufferChannel = NotifyFeed | "security";

export const FEED_SETTINGS_ID: Record<NotifyFeed, string> = {
  "renovate-pr": "renovate-pr-settings",
  "dependabot-alert": "dependabot-alert-settings",
};

export interface FeedNotifySettings {
  id: string;
  kind: "feed";
  feed: NotifyFeed;
  enabled: boolean;
  groupId?: string;
  /**
   * Dependabot only. Renovate pull requests carry no severity, so the field is
   * absent there rather than set to a value that quietly filters nothing.
   */
  minSeverity?: Severity;
  /**
   * How many emails an event storm produces.
   *
   * `per-repository` holds events briefly and sends one message per repository,
   * because the common case is not one alert arriving. It is Dependabot being
   * switched on and raising every alert a repository has at once.
   * `per-alert` sends immediately, which is faster and much louder.
   */
  grouping: "per-alert" | "per-repository";
  subjectTemplate: string;
  bodyTemplate: string;
  /** Empty means the email wording above. See WidgetAlarm for why. */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  updatedBy?: string;
  updatedAt?: string;
}

const FEED_DEFAULTS: Record<NotifyFeed, FeedNotifySettings> = {
  "renovate-pr": {
    id: FEED_SETTINGS_ID["renovate-pr"],
    kind: "feed",
    feed: "renovate-pr",
    // Off until somebody turns it on, for the same reason the security toggle
    // is: enabling by default emails whoever is in a group the moment one exists.
    enabled: false,
    grouping: "per-repository",
    subjectTemplate: DEFAULT_RENOVATE_SUBJECT,
    bodyTemplate: DEFAULT_RENOVATE_BODY,
  },
  "dependabot-alert": {
    id: FEED_SETTINGS_ID["dependabot-alert"],
    kind: "feed",
    feed: "dependabot-alert",
    enabled: false,
    // Every new Dependabot alert on a busy organization is a lot of mail. High
    // and above is the floor that keeps the first week from training people to
    // filter it, and it is adjustable.
    minSeverity: "high",
    grouping: "per-repository",
    subjectTemplate: DEFAULT_DEPENDABOT_SUBJECT,
    bodyTemplate: DEFAULT_DEPENDABOT_BODY,
  },
};

export async function getFeedSettings(feed: NotifyFeed): Promise<FeedNotifySettings> {
  const found = await getById<FeedNotifySettings>(FEED_SETTINGS_ID[feed]);
  if (found?.kind === "feed" && found.feed === feed) return { ...FEED_DEFAULTS[feed], ...found };
  return { ...FEED_DEFAULTS[feed] };
}

export async function saveFeedSettings(
  feed: NotifyFeed,
  data: Partial<Pick<FeedNotifySettings, "enabled" | "groupId" | "minSeverity"
    | "grouping" | "subjectTemplate" | "bodyTemplate"
    | "teamsSubjectTemplate" | "teamsBodyTemplate">>,
  actor: string,
): Promise<FeedNotifySettings> {
  const current = await getFeedSettings(feed);
  const updated: FeedNotifySettings = {
    ...current,
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    id: FEED_SETTINGS_ID[feed],
    kind: "feed",
    feed,
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  // Renovate has no severity. Accepting one would store a field the notifier
  // never reads, which reads back as a filter that is silently doing nothing.
  if (feed !== "dependabot-alert") delete updated.minSeverity;
  await put(updated);
  const label = feed === "renovate-pr" ? "Renovate pull request" : "Dependabot alert";
  const changes = describeChanges(current, updated, [
    ["enabled", `${label} emails`],
    ["groupId", "email group"],
    ["minSeverity", "severity floor"],
    ["grouping", "grouping"],
    ["subjectTemplate", "subject template edited"],
    ["bodyTemplate", "body template edited"],
    ["teamsSubjectTemplate", "Teams subject template edited"],
    ["teamsBodyTemplate", "Teams body template edited"],
  ]);
  await logActivity(
    "config.updated" as any, actor, "", `notify_${feed}`,
    changes.length
      ? `${label}: ${changes.join(", ")}`
      : `${label} settings saved with no change`,
    { enabled: updated.enabled, minSeverity: updated.minSeverity, changed: changes }, "app",
  );
  return updated;
}

// ── the pending-notification buffer ───────────────────────────────────
//
// Grouping needs somewhere to hold an event until its neighbours arrive.
// Enabling Dependabot on one repository raises every alert it has at once, and
// one email each is a blast nobody reads, so events land here and the alarm
// evaluator, which already runs on a tick, sends one message per repository.
//
// Rows are marked sent rather than deleted, and expire on their own. Deleting
// them would be tidier and is deliberately not done: a delete that raced with a
// flush would lose a notification with nothing to show it ever existed, and
// this table is the same one alarms live in.

export interface PendingNotification {
  id: string;
  kind: "pending";
  feed: BufferChannel;
  /** The repository, which is one of the two axes the flush can group on. */
  repo: string;
  /** Rendered fields for one line of the digest. */
  item: Record<string, string>;
  /** The event's own time, not the flush's. */
  occurredAt: string;
  sentAt?: string;
  /** Epoch seconds. Long enough to survive an evaluator outage. */
  ttl: number;
}

const PENDING_TTL_HOURS = 24;

export async function bufferNotification(
  feed: BufferChannel,
  repo: string,
  item: Record<string, string>,
  occurredAt: string,
): Promise<void> {
  const row: PendingNotification = {
    id: `pending#${feed}#${crypto.randomUUID()}`,
    kind: "pending",
    feed,
    repo,
    item,
    occurredAt,
    ttl: Math.floor(Date.now() / 1000) + PENDING_TTL_HOURS * 3600,
  };
  await put(row);
}

/** Everything buffered and not yet sent, oldest first. */
export async function listPending(feed?: BufferChannel): Promise<PendingNotification[]> {
  const rows = (await allRecords()).filter(
    r => r.kind === "pending" && !(r as PendingNotification).sentAt,
  ) as PendingNotification[];
  return rows
    .filter(r => !feed || r.feed === feed)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/**
 * Marked one at a time and only after a successful publish.
 *
 * Marking the batch before publishing would drop the whole group if SNS failed;
 * marking after means a failure leaves them pending and the next tick tries
 * again. The cost of that choice is a possible duplicate digest rather than a
 * silent loss, which is the right way round for a notification.
 */
export async function markPendingSent(ids: string[]): Promise<void> {
  const now = new Date().toISOString();
  for (const id of ids) {
    const row = await getById<PendingNotification>(id);
    if (!row || row.kind !== "pending" || row.sentAt) continue;
    await put({ ...row, sentAt: now });
  }
}

// ── the pull request feature's own switches ───────────────────────────
//
// Two, not one. Monitoring off means the whole feature is dormant: no GitHub
// query, no list, no reminders, nothing scheduled doing work on its behalf.
// Reminders off leaves the list working and stops anything being posted, which
// is the common case, people want to see the queue without the app talking to
// anyone.

export const PR_SETTINGS_ID = "pr-settings";

export interface PrFeatureSettings {
  id: typeof PR_SETTINGS_ID;
  kind: "pr-settings";
  /** The whole feature. Off means nothing is fetched or shown. */
  monitoringEnabled: boolean;
  /** Reminders only. Off leaves the list live and posts nothing. */
  remindersEnabled: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

/**
 * On by default for the list, off by default for reminders.
 *
 * Seeing the queue is inert; posting on somebody's pull request is not, and a
 * feature that starts commenting the moment it is deployed would be a surprise
 * nobody asked for.
 */
const DEFAULT_PR_SETTINGS: PrFeatureSettings = {
  id: PR_SETTINGS_ID,
  kind: "pr-settings",
  monitoringEnabled: true,
  remindersEnabled: false,
};

export async function getPrSettings(): Promise<PrFeatureSettings> {
  const found = await getById<PrFeatureSettings>(PR_SETTINGS_ID);
  if (found?.kind === "pr-settings") return { ...DEFAULT_PR_SETTINGS, ...found };
  return { ...DEFAULT_PR_SETTINGS };
}

export async function savePrSettings(
  data: Partial<Pick<PrFeatureSettings, "monitoringEnabled" | "remindersEnabled">>,
  actor: string,
): Promise<PrFeatureSettings> {
  const current = await getPrSettings();
  const updated: PrFeatureSettings = {
    ...current,
    ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)),
    id: PR_SETTINGS_ID,
    kind: "pr-settings",
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };
  await put(updated);

  const changes = describeChanges(current, updated, [
    ["monitoringEnabled", "pull request monitoring"],
    ["remindersEnabled", "stale reminders"],
  ]);
  await logActivity(
    "config.updated" as any, actor, "", "pr_monitoring",
    changes.length ? `Pull requests: ${changes.join(", ")}` : "Pull request settings saved with no change",
    { ...updated }, "app",
  );
  return updated;
}

// ── who is muted, and how widely ──────────────────────────────────────
//
// Three scopes above the per-pull-request one, because "stop reminding this
// person" is asked at three different sizes: they are on leave, they do not
// work on that repository, or this one pull request is not theirs to chase.
//
// One row rather than one per mute. The whole set is read on every pass and
// rendered whole in the UI, so a row per entry would be a scan to answer a
// question that fits comfortably in a single item.

export const PR_MUTES_ID = "pr-mutes";

export interface PrMutes {
  id: typeof PR_MUTES_ID;
  kind: "pr-mutes";
  /** Never reminded about anything, anywhere. */
  global: string[];
  /** Never reminded about pull requests in these repositories. */
  byRepo: Record<string, string[]>;
  updatedBy?: string;
  updatedAt?: string;
}

const DEFAULT_MUTES: PrMutes = { id: PR_MUTES_ID, kind: "pr-mutes", global: [], byRepo: {} };

export async function getPrMutes(): Promise<PrMutes> {
  const found = await getById<PrMutes>(PR_MUTES_ID);
  if (found?.kind === "pr-mutes") {
    return { ...DEFAULT_MUTES, ...found, global: found.global ?? [], byRepo: found.byRepo ?? {} };
  }
  return { ...DEFAULT_MUTES };
}

/**
 * Add or remove one person at one scope.
 *
 * Deliberately not "save the whole object". Two admins editing at once would
 * otherwise overwrite each other silently, and the losing edit is a mute that
 * somebody believes they set.
 */
export async function setPrMute(
  scope: { kind: "global" } | { kind: "repo"; repo: string },
  login: string,
  muted: boolean,
  actor: string,
): Promise<PrMutes> {
  const current = await getPrMutes();
  const key = login.trim();
  const same = (a: string) => a.toLowerCase() === key.toLowerCase();

  const updated: PrMutes = {
    ...current,
    global: [...current.global],
    byRepo: Object.fromEntries(Object.entries(current.byRepo).map(([k, v]) => [k, [...v]])),
    updatedBy: actor,
    updatedAt: new Date().toISOString(),
  };

  if (scope.kind === "global") {
    updated.global = muted
      ? (updated.global.some(same) ? updated.global : [...updated.global, key])
      : updated.global.filter(l => !same(l));
  } else {
    const list = updated.byRepo[scope.repo] ?? [];
    const next = muted
      ? (list.some(same) ? list : [...list, key])
      : list.filter(l => !same(l));
    // An empty list is removed rather than kept, so the stored shape matches
    // what it means: no entry is the same as nobody muted there.
    if (next.length) updated.byRepo[scope.repo] = next;
    else delete updated.byRepo[scope.repo];
  }

  await put(updated);
  const where = scope.kind === "global" ? "everywhere" : `in ${scope.repo}`;
  await logActivity(
    "config.updated" as any, actor, scope.kind === "repo" ? scope.repo : "", "pr_mute",
    `${key} ${muted ? "muted" : "unmuted"} for pull request reminders ${where}`,
    { login: key, scope: scope.kind, repo: scope.kind === "repo" ? scope.repo : undefined, muted }, "app",
  );
  return updated;
}

// ── stale pull requests: nudge history and pauses ─────────────────────
//
// One row per pull request, holding both what we have sent and what an admin
// has silenced. They are read and written together on every pass, so splitting
// them would buy a second round trip and a chance to disagree.
//
// The TTL is refreshed on every write. A pull request being nudged keeps its
// row alive indefinitely; once it merges nothing writes again and the row ages
// out. Long enough that a pause set today survives six months of silence,
// because a pause quietly expiring is the failure people would never forgive.

export interface PrState {
  id: string;
  kind: "pr-state";
  repo: string;
  number: number;
  /** When the last nudge was posted. Null until the first one. */
  lastNudgedAt?: string;
  /** The sticky comment, so the next nudge can remove it before posting. */
  lastCommentId?: number;
  /** How many have been sent, purely so the comment can say so. */
  nudgeCount?: number;
  /** Admin has silenced this pull request entirely. */
  paused?: boolean;
  /** Admin has silenced these specific people on this pull request. */
  pausedLogins?: string[];
  pausedBy?: string;
  pausedAt?: string;
  ttl: number;
}

const PR_STATE_TTL_DAYS = 180;

export function prStateId(repo: string, number: number): string {
  return `pr-state#${repo}#${number}`;
}

export async function getPrState(repo: string, number: number): Promise<PrState | undefined> {
  const found = await getById<PrState>(prStateId(repo, number));
  return found?.kind === "pr-state" ? found : undefined;
}

/**
 * A DynamoDB item stops at 400KB, and the list is unbounded.
 *
 * Held well under, because exceeding it is not a graceful failure: the write is
 * rejected and the snapshot silently stops updating, which looks exactly like a
 * cache that is working and merely old.
 */
const SNAPSHOT_BUDGET_BYTES = 300_000;

/** Kept longer than any refresh interval, short enough not to outlive relevance. */
const SNAPSHOT_TTL_HOURS = 24;

/**
 * Stores the pull request list for the tab to open with.
 *
 * Trimmed rather than refused when it is too large: half a list now beats no
 * list, and the count says how much arrived so the caller can say so.
 */
export async function savePrSnapshot(
  data: { prs: unknown[]; truncated: boolean },
): Promise<void> {
  let prs = data.prs;
  let payload = JSON.stringify({ prs, truncated: data.truncated });

  while (Buffer.byteLength(payload) > SNAPSHOT_BUDGET_BYTES && prs.length > 1) {
    prs = prs.slice(0, Math.floor(prs.length * 0.8));
    payload = JSON.stringify({ prs, truncated: true });
  }

  await put({
    id: "pr-snapshot", kind: "pr-snapshot", payload,
    cachedAt: new Date().toISOString(),
    count: prs.length,
    ttl: Math.floor(Date.now() / 1000) + SNAPSHOT_TTL_HOURS * 3600,
  });
}

/** The stored list, or null when there has never been one. */
export async function readPrSnapshot(): Promise<
  { prs: any[]; truncated: boolean; cachedAt: string } | null
> {
  const row = await getById<PrSnapshot>("pr-snapshot");
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload);
    return { prs: parsed.prs ?? [], truncated: !!parsed.truncated, cachedAt: row.cachedAt };
  } catch {
    // A corrupt snapshot must not take the tab down with it; the caller falls
    // back to fetching, which is what it did before this existed.
    return null;
  }
}

/**
 * A widget's rows, computed on the schedule rather than while somebody waits.
 *
 * Run inside the request that draws the card, opening Overview means a full
 * scan of the graph table, live GitHub calls for the dependency widgets, and,
 * for the three subject-by-subject checks, up to twenty-five commit searches
 * against a budget of thirty a minute, all on a cold process immediately after
 * launch.
 *
 * The scheduled pass already computes these rows for any widget an alarm
 * watches. Storing them for every widget costs that pass a little more and
 * takes the whole of it off the page load.
 */
export interface WidgetSnapshot {
  id: string;
  kind: "widget-snapshot";
  widgetId: string;
  /** The rows, JSON-encoded. Trimmed if the full set will not fit. */
  payload: string;
  /** How many rows the check actually produced, before any trimming. */
  total: number;
  /** True when `payload` holds fewer rows than `total`. */
  trimmed: boolean;
  /**
   * Repositories in the organization when this was computed, so the card can
   * draw its share on the first paint rather than after a second request.
   */
  repoTotal?: number;
  /** Set when the check could not complete. Rows are then not to be trusted. */
  error?: string;
  computedAt: string;
  ttl: number;
}

/**
 * Kept well past the five-minute pass that writes it, so a Lambda that stops
 * running leaves a visibly old snapshot rather than an empty dashboard. The age
 * is returned with it and shown on screen; staleness is a thing to report, not
 * to hide by discarding.
 */
const WIDGET_SNAPSHOT_TTL_HOURS = 24;

/** Below the 400KB item limit, with room for the rest of the row. */
const WIDGET_SNAPSHOT_BUDGET_BYTES = 300_000;

export function widgetSnapshotId(widgetId: string): string {
  return `widget-snapshot#${widgetId}`;
}

export async function saveWidgetSnapshot(
  widgetId: string,
  result: { rows: unknown[] | null; error?: string },
  /**
   * How many repositories the count is out of, at the moment the rows were
   * computed.
   *
   * Stored with the answer because it *is* part of the answer. Taking the rows
   * from here and the denominator from a separate listing that lands seconds
   * later opens every card with no share, drawn amber, repainting to its real
   * colour afterwards. A stored answer that needs a live request to be read is
   * not a stored answer.
   */
  repoTotal?: number | null,
): Promise<void> {
  const all = result.rows ?? [];
  let rows = all;
  let payload = JSON.stringify(rows);

  // Trimmed rather than refused: a card needs a count and three names, and the
  // count below is the true one either way. Only the detail table wants every
  // row, and it can read live when this says it is short.
  while (Buffer.byteLength(payload) > WIDGET_SNAPSHOT_BUDGET_BYTES && rows.length > 1) {
    rows = rows.slice(0, Math.floor(rows.length * 0.8));
    payload = JSON.stringify(rows);
  }

  await put({
    id: widgetSnapshotId(widgetId),
    kind: "widget-snapshot",
    widgetId,
    payload,
    total: all.length,
    trimmed: rows.length < all.length,
    ...(typeof repoTotal === "number" ? { repoTotal } : {}),
    ...(result.error ? { error: result.error } : {}),
    computedAt: new Date().toISOString(),
    ttl: Math.floor(Date.now() / 1000) + WIDGET_SNAPSHOT_TTL_HOURS * 3600,
  });
}

export interface ReadWidgetSnapshot {
  widgetId: string;
  rows: any[];
  total: number;
  trimmed: boolean;
  /** Repositories in the organization when this was computed, if known. */
  repoTotal?: number;
  error?: string;
  computedAt: string;
}

/** Every stored snapshot, in one read, for the dashboard to open with. */
export async function readWidgetSnapshots(): Promise<ReadWidgetSnapshot[]> {
  const rows = (await allRecords()).filter(r => r.kind === "widget-snapshot") as WidgetSnapshot[];
  const out: ReadWidgetSnapshot[] = [];
  for (const row of rows) {
    try {
      out.push({
        widgetId: row.widgetId,
        rows: JSON.parse(row.payload) ?? [],
        total: row.total ?? 0,
        trimmed: !!row.trimmed,
        ...(typeof row.repoTotal === "number" ? { repoTotal: row.repoTotal } : {}),
        ...(row.error ? { error: row.error } : {}),
        computedAt: row.computedAt,
      });
    } catch {
      // One unreadable snapshot must not take the dashboard down with it. The
      // widget falls back to computing live, which is what it did before.
    }
  }
  return out;
}

/** Drops a widget's snapshot, so a deleted widget leaves nothing behind. */
export async function deleteWidgetSnapshot(widgetId: string): Promise<void> {
  const id = widgetSnapshotId(widgetId);
  if (hasTable("ALARMS_TABLE")) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memStore = memStore.filter(r => r.id !== id);
  }
}

export async function listPrStates(): Promise<PrState[]> {
  return (await allRecords()).filter(r => r.kind === "pr-state") as PrState[];
}

async function savePrState(row: PrState): Promise<void> {
  await put({ ...row, ttl: Math.floor(Date.now() / 1000) + PR_STATE_TTL_DAYS * 86_400 });
}

/** Close enough to expiry that keeping it alive is worth one write. */
const PR_STATE_TOUCH_WITHIN_SEC = 30 * 86_400;

/**
 * Push a paused pull request's expiry out, without recording a nudge.
 *
 * The expiry is re-stamped on every write, so a row stays alive as long as
 * something keeps happening to that pull request. A *paused* one is the exact
 * case where nothing does: it is skipped before any nudge is posted, so nothing
 * called `savePrState`, so after 180 days the row was deleted and the pause
 * went with it. Reminders then resumed on a pull request somebody had
 * deliberately silenced, with nothing anywhere to explain why.
 *
 * Deliberately not `recordNudge`, which is the other thing that would keep the
 * row alive: that restarts the seven-day clock, so lifting the pause would be
 * followed by a week of silence instead of the next reminder.
 *
 * Only within the last month of the row's life, so a paused pull request costs
 * one write every five months rather than one on every pass.
 */
export async function touchPrState(repo: string, number: number): Promise<boolean> {
  const existing = await getPrState(repo, number);
  if (!existing) return false;
  // An unpaused row holds nothing worth preserving, the next nudge rebuilds it.
  if (!existing.paused && !existing.pausedLogins?.length) return false;
  const now = Math.floor(Date.now() / 1000);
  if (existing.ttl - now > PR_STATE_TOUCH_WITHIN_SEC) return false;
  await savePrState(existing);
  return true;
}

export async function recordNudge(
  repo: string, number: number, commentId: number | undefined,
): Promise<void> {
  const existing = await getPrState(repo, number);
  await savePrState({
    ...(existing ?? { id: prStateId(repo, number), kind: "pr-state", repo, number, ttl: 0 }),
    lastNudgedAt: new Date().toISOString(),
    lastCommentId: commentId,
    nudgeCount: (existing?.nudgeCount ?? 0) + 1,
  });
}

export async function setPrPause(
  repo: string, number: number,
  data: { paused?: boolean; pausedLogins?: string[] },
  actor: string,
): Promise<PrState> {
  const existing = await getPrState(repo, number)
    ?? { id: prStateId(repo, number), kind: "pr-state" as const, repo, number, ttl: 0 };
  const updated: PrState = {
    ...existing,
    ...(data.paused !== undefined ? { paused: data.paused } : {}),
    ...(data.pausedLogins !== undefined ? { pausedLogins: data.pausedLogins } : {}),
    pausedBy: actor,
    pausedAt: new Date().toISOString(),
  };
  await savePrState(updated);

  const what = updated.paused
    ? "all reminders paused"
    : (updated.pausedLogins?.length
        ? `reminders paused for ${updated.pausedLogins.join(", ")}`
        : "reminders resumed");
  await logActivity(
    "config.updated" as any, actor, repo, `pr#${number}`,
    `${repo}#${number}: ${what}`,
    { repo, number, paused: updated.paused, pausedLogins: updated.pausedLogins }, "app",
  );
  return updated;
}

// ── test seam ──
export function __resetAlarmStoreForTests(): void {
  memStore = [];
}
