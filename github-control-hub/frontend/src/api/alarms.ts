import { apiGet, apiPost, apiPut, apiDelete } from "./client";

export type Severity = "critical" | "high" | "medium" | "low";

export type AlarmCondition =
  | { kind: "count"; metric: string; op: "gte" | "lte"; threshold: number }
  | { kind: "severity"; metric: "vulnRepos.worstSeverity"; atLeast: Severity }
  /**
   * Told about each new row as it appears, rather than when a count crosses a
   * line. Carries a metric only so the message can still say the total.
   */
  | { kind: "each"; metric: string };

export interface MetricSpec {
  metric: string;
  kind: "count" | "severity" | "each";
  label: string;
  unit?: string;
  hint?: string;
}

export interface WidgetConditions {
  widgetId: string;
  title: string;
  conditions: MetricSpec[];
  intervalMinutes: number;
  defaults: { subject: string; body: string };
  /**
   * The wording for a reading with no threshold.
   *
   * Optional because a server older than this field simply will not send
   * it, and the form falls back to the threshold wording rather than
   * rendering nothing.
   */
  eachDefaults?: { subject: string; body: string };
}

export interface WidgetAlarm {
  id: string;
  widgetId: string;
  name: string;
  condition: AlarmCondition;
  groupId: string;
  subjectTemplate: string;
  bodyTemplate: string;
  /** Empty means the email wording above is used for Teams as well. */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  notifyOnRecovery: boolean;
  /**
   * How often the evaluator looks, from the evaluator rather than guessed here.
   * Null when the subject no longer exists.
   */
  intervalMinutes?: number | null;
  enabled: boolean;
  state: "OK" | "ALARM";
  lastCheckedAt?: string;
  lastValue?: number | null;
  lastFiredAt?: string;
  lastError?: string;
}

export interface GroupMember {
  endpoint: string;
  subscriptionArn: string;
  confirmed: boolean;
}

export interface EmailGroup {
  id: string;
  name: string;
  topicArn: string;
  members: GroupMember[];
  membersError?: string;
  /** People this group DMs in Teams, by work email address. */
  teamsRecipients?: string[];
  /** Per Teams recipient, by address. Absent means the group's zone. */
  recipientZones?: Record<string, string>;
  /** This group's email zone, and the default for its Teams people. */
  timeZone?: string;
}

export interface SecurityNotifySettings {
  enabled: boolean;
  groupId?: string;
  minSeverity: Severity;
  subjectTemplate: string;
  bodyTemplate: string;
  /** Empty means the email wording above is used for Teams as well. */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  /** IANA zone that {{time}} is rendered in, for alarm and security emails. */
  timezone: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface TemplateVariable { name: string; description: string }

export const fetchAlarms = () => apiGet<WidgetAlarm[]>("/alarms");
export const fetchWidgetConditions = (widgetId: string) =>
  apiGet<WidgetConditions>(`/alarms/widgets/${widgetId}/conditions`);
export const fetchTemplateVariables = () => apiGet<TemplateVariable[]>("/alarms/variables");

export const createAlarmApi = (data: Partial<WidgetAlarm> & { widgetId: string }) =>
  apiPost<WidgetAlarm>("/alarms", data);
export const updateAlarmApi = (id: string, data: Partial<WidgetAlarm>) =>
  apiPut<WidgetAlarm>(`/alarms/${id}`, data);
export const deleteAlarmApi = (id: string) =>
  apiDelete<{ message: string }>(`/alarms/${id}`);

export const fetchGroups = () => apiGet<EmailGroup[]>("/alarms/groups");

/**
 * One person's zone, in either column.
 *
 * Teams is rendered in it exactly. Email cannot be, because one SNS publish
 * hands every subscriber the same body, so the one email names every zone its
 * people are in and each reader finds their own.
 */
export const setRecipientTimeZone = (id: string, address: string, timeZone: string) =>
  apiPut<{ recipientZones: Record<string, string> }>(
    `/alarms/groups/${id}/people/${encodeURIComponent(address)}/timezone`, { timeZone });

export const setGroupTimeZone = (id: string, timeZone: string) =>
  apiPut<{ timeZone?: string }>(`/alarms/groups/${id}/timezone`, { timeZone });

export const addGroupTeams = (id: string, address: string) =>
  apiPost<{ teamsRecipients: string[] }>(`/alarms/groups/${id}/teams`, { address });

export const removeGroupTeams = (id: string, address: string) =>
  apiDelete<{ teamsRecipients: string[] }>(
    `/alarms/groups/${id}/teams/${encodeURIComponent(address)}`);

export interface TeamsFlow {
  configured: boolean;
  setBy?: string;
  setAt?: string;
}

export const fetchTeamsFlow = () => apiGet<TeamsFlow>("/alarms/teams-flow");
export const saveTeamsFlow = (url: string) => apiPut<TeamsFlow>("/alarms/teams-flow", { url });
export const createGroupApi = (name: string) =>
  apiPost<EmailGroup>("/alarms/groups", { name });
/** `force` deletes even when alarms still point at the group. */
export const deleteGroupApi = (id: string, force = false) =>
  apiDelete<{ message: string }>(`/alarms/groups/${id}${force ? "?force=1" : ""}`);
export const addGroupMemberApi = (id: string, email: string) =>
  apiPost<{ message: string }>(`/alarms/groups/${id}/members`, { email });
/**
 * The address goes too, because an unconfirmed subscription has no ARN.
 *
 * AWS cannot withdraw a pending invitation, so the server records the address
 * as revoked instead. Without it here, the only identifier for that row is the
 * literal string "PendingConfirmation", which names everybody who has not
 * clicked their link rather than the one being cancelled.
 */
export const removeGroupMemberApi = (id: string, subscriptionArn: string, email?: string) =>
  apiDelete<{ message: string }>(
    `/alarms/groups/${id}/members?subscriptionArn=${encodeURIComponent(subscriptionArn)}`
    + (email ? `&email=${encodeURIComponent(email)}` : ""));
export const testGroupApi = (id: string) =>
  apiPost<{ message: string }>(`/alarms/groups/${id}/test`, {});

export const fetchSecuritySettings = () => apiGet<SecurityNotifySettings>("/alarms/security");
export const saveSecuritySettingsApi = (data: Partial<SecurityNotifySettings>) =>
  apiPut<SecurityNotifySettings>("/alarms/security", data);

/**
 * The two per-event feeds on the Vulnerabilities tab.
 *
 * minSeverity is optional because Renovate pull requests do not carry one; the
 * backend refuses it on that feed rather than storing a filter it never reads.
 */
export type NotifyFeed = "renovate-pr" | "dependabot-alert";

export interface FeedNotifySettings {
  id: string;
  kind: "feed";
  feed: NotifyFeed;
  enabled: boolean;
  groupId?: string;
  minSeverity?: Severity;
  /** per-repository holds events briefly and sends one message per repository. */
  grouping: "per-alert" | "per-repository";
  subjectTemplate: string;
  bodyTemplate: string;
  /** Empty means the email wording above is used for Teams as well. */
  teamsSubjectTemplate?: string;
  teamsBodyTemplate?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export const fetchFeedSettings = (feed: NotifyFeed) =>
  apiGet<FeedNotifySettings>(`/alarms/feeds/${feed}`);
export const saveFeedSettingsApi = (feed: NotifyFeed, data: Partial<FeedNotifySettings>) =>
  apiPut<FeedNotifySettings>(`/alarms/feeds/${feed}`, data);

/** "every 15 minutes" / "every hour", for telling the user how fast it reacts. */
export function describeInterval(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "every hour" : `every ${h} hours`;
  }
  return `every ${minutes} minutes`;
}

/** A one-line summary of a condition, for the widget card and the alarm list. */
export function describeCondition(condition: AlarmCondition, specs: MetricSpec[]): string {
  // Matched on both, because one metric now carries two readings of itself and
  // finding it by name alone returns whichever was declared first.
  const spec = specs.find(s => s.metric === condition.metric && s.kind === condition.kind)
    ?? specs.find(s => s.metric === condition.metric);
  const label = spec?.label ?? condition.metric;
  if (condition.kind === "severity") return `${label} reaches ${condition.atLeast}`;
  if (condition.kind === "each") return spec?.label ?? "Every new one";
  const comparator = condition.op === "gte" ? "is at or above" : "is at or below";
  return `${label} ${comparator} ${condition.threshold}${spec?.unit ? ` ${spec.unit}` : ""}`;
}

// ── one person's own alarms ──

/**
 * Where somebody's own alarms are delivered.
 *
 * Never a group they choose. The server resolves it from the session, so this
 * carries no group id in either direction and there is no request shape that
 * could point a personal alarm at an organization topic.
 */
export interface PersonalDestination {
  groupId: string;
  emails: GroupMember[];
  teams: string[];
  timeZone: string | null;
  recipientZones: Record<string, string>;
}

export const fetchMyAlarms = () => apiGet<WidgetAlarm[]>("/me/alarms");
export const createMyAlarm = (data: Partial<WidgetAlarm> & { widgetId: string }) =>
  apiPost<WidgetAlarm>("/me/alarms", data);
export const updateMyAlarm = (id: string, data: Partial<WidgetAlarm>) =>
  apiPut<WidgetAlarm>(`/me/alarms/${id}`, data);
export const deleteMyAlarm = (id: string) =>
  apiDelete<{ message: string }>(`/me/alarms/${id}`);

export const fetchMyDestination = () =>
  apiGet<PersonalDestination>("/me/alarms/destination");
export const addMyEmail = (email: string) =>
  apiPost<{ message: string }>("/me/alarms/destination/email", { email });
export const removeMyEmail = (subscriptionArn: string, email: string) =>
  apiDelete<{ message: string }>(
    `/me/alarms/destination/email?subscriptionArn=${encodeURIComponent(subscriptionArn)}`
    + `&email=${encodeURIComponent(email)}`);
export const addMyTeams = (address: string) =>
  apiPost<{ message: string }>("/me/alarms/destination/teams", { address });
export const removeMyTeams = (address: string) =>
  apiDelete<{ message: string }>(
    `/me/alarms/destination/teams/${encodeURIComponent(address)}`);
export const setMyTimeZone = (timeZone: string | null) =>
  apiPut<{ message: string }>("/me/alarms/destination/timezone", { timeZone });
