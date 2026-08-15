import crypto from "crypto";

import { logActivity } from "./activityService";
import { docClient, usesDynamo, tableName, PutCommand, ScanCommand, GetCommand, DeleteCommand } from "../utils/dynamo";
import type { AlarmCondition, AlarmState, Severity } from "../alarms/conditions";
import {
  DEFAULT_ALARM_SUBJECT, DEFAULT_ALARM_BODY,
  DEFAULT_SECURITY_SUBJECT, DEFAULT_SECURITY_BODY,
  DEFAULT_RENOVATE_SUBJECT, DEFAULT_RENOVATE_BODY,
  DEFAULT_DEPENDABOT_SUBJECT, DEFAULT_DEPENDABOT_BODY,
} from "../alarms/message";

/**
 * Alarms, the email groups they notify, and the security-alert toggle.
 *
 * All three live in one table keyed by id and told apart by `kind`, the same
 * shape the alerts and widgets tables use. Alarm runtime state — whether it is
 * currently firing, how many clean checks it has seen — is stored on the alarm
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
  notifyOnRecovery: boolean;
  enabled: boolean;

  // ── runtime, written by the evaluator ──
  state: AlarmState;
  cleanStreak: number;
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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
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
   * IANA zone the {{time}} variable is rendered in, for both alarm and
   * security emails. UTC by default, because one email reaches a group who may
   * be anywhere; set it when everyone reading them is in one place.
   */
  timezone: string;
  updatedBy?: string;
  updatedAt?: string;
}

type AnyRecord = WidgetAlarm | EmailGroup | SecurityNotifySettings | FeedNotifySettings;

const TABLE = () => tableName("ALARMS_TABLE");

/** In-memory fallback for local development, as the other services do. */
let memStore: AnyRecord[] = [];

async function allRecords(): Promise<AnyRecord[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return (result.Items || []) as AnyRecord[];
  }
  return memStore;
}

async function put(record: AnyRecord): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: record }));
    return;
  }
  const i = memStore.findIndex(r => r.id === record.id);
  if (i >= 0) memStore[i] = record;
  else memStore.push(record);
}

async function getById<T extends AnyRecord>(id: string): Promise<T | undefined> {
  if (usesDynamo()) {
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
    subjectTemplate?: string; bodyTemplate?: string; notifyOnRecovery?: boolean; enabled?: boolean;
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
    subjectTemplate: data.subjectTemplate || DEFAULT_ALARM_SUBJECT,
    bodyTemplate: data.bodyTemplate || DEFAULT_ALARM_BODY,
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
  );
  return alarm;
}

export async function updateAlarm(
  id: string,
  data: Partial<Pick<WidgetAlarm, "name" | "condition" | "groupId" | "subjectTemplate"
    | "bodyTemplate" | "notifyOnRecovery" | "enabled">>,
  actor: string,
): Promise<WidgetAlarm | null> {
  const existing = await getAlarm(id);
  if (!existing) return null;

  const updated: WidgetAlarm = { ...existing, updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) (updated as any)[k] = v;
  }

  // Changing what an alarm watches makes its stored state meaningless: an
  // alarm firing on "critical >= 1" that becomes "total >= 500" would stay in
  // ALARM and never send the email for the new condition, because the first
  // breach it sees is not a transition.
  const conditionChanged = data.condition !== undefined
    && JSON.stringify(data.condition) !== JSON.stringify(existing.condition);
  if (conditionChanged) {
    updated.state = "OK";
    updated.cleanStreak = 0;
    delete updated.lastValue;
    delete updated.lastError;
  }

  await put(updated);
  await logActivity(
    "config.updated" as any, actor, "", "alarm",
    `Updated alarm "${updated.name}"`, { alarmId: id, conditionChanged }, "app",
  );
  return updated;
}

/** Written by the evaluator. Never touches the user's configuration fields. */
export async function saveAlarmRuntime(
  id: string,
  runtime: { state: AlarmState; cleanStreak: number; lastCheckedAt: string;
             lastValue?: number | null; lastFiredAt?: string; lastError?: string },
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
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memStore = memStore.filter(r => r.id !== id);
  }
  await logActivity(
    "config.updated" as any, actor, "", "alarm",
    `Deleted alarm "${existing.name}"`, { alarmId: id }, "app",
  );
  return true;
}

// ── email groups ──────────────────────────────────────────────────────

export async function listGroups(): Promise<EmailGroup[]> {
  return (await allRecords()).filter(r => r.kind === "group") as EmailGroup[];
}

export async function getGroup(id: string): Promise<EmailGroup | undefined> {
  const found = await getById<EmailGroup>(id);
  return found?.kind === "group" ? found : undefined;
}

export async function saveGroup(group: EmailGroup): Promise<void> {
  await put(group);
}

export async function createGroupRecord(
  name: string, topicArn: string, actor: string,
): Promise<EmailGroup> {
  const now = new Date().toISOString();
  const group: EmailGroup = {
    id: crypto.randomUUID(), kind: "group", name, topicArn,
    createdBy: actor, createdAt: now, updatedAt: now,
  };
  await put(group);
  await logActivity(
    "config.updated" as any, actor, "", "alarm_group",
    `Created email group "${name}"`, { groupId: group.id, topicArn }, "app",
  );
  return group;
}

export async function deleteGroupRecord(id: string, actor: string): Promise<EmailGroup | null> {
  const existing = await getGroup(id);
  if (!existing) return null;
  if (usesDynamo()) {
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

export async function getSecuritySettings(): Promise<SecurityNotifySettings> {
  const found = await getById<SecurityNotifySettings>(SECURITY_SETTINGS_ID);
  if (found?.kind === "security") return { ...DEFAULT_SECURITY_SETTINGS, ...found };
  return { ...DEFAULT_SECURITY_SETTINGS };
}

export async function saveSecuritySettings(
  data: Partial<Pick<SecurityNotifySettings, "enabled" | "groupId" | "minSeverity"
    | "subjectTemplate" | "bodyTemplate" | "timezone">>,
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
  await logActivity(
    "config.updated" as any, actor, "", "alarm_security",
    updated.enabled
      ? `Security alert emails enabled (${updated.minSeverity} and above)`
      : "Security alert emails disabled",
    { enabled: updated.enabled, minSeverity: updated.minSeverity }, "app",
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
  subjectTemplate: string;
  bodyTemplate: string;
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
    | "subjectTemplate" | "bodyTemplate">>,
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
  await logActivity(
    "config.updated" as any, actor, "", `notify_${feed}`,
    updated.enabled
      ? `${label} emails enabled${updated.minSeverity ? ` (${updated.minSeverity} and above)` : ""}`
      : `${label} emails disabled`,
    { enabled: updated.enabled, minSeverity: updated.minSeverity }, "app",
  );
  return updated;
}

// ── test seam ──
export function __resetAlarmStoreForTests(): void {
  memStore = [];
}
