import { apiGet, apiPost, apiPut, apiDelete } from "./client";

export type Severity = "critical" | "high" | "medium" | "low";

export type AlarmCondition =
  | { kind: "count"; metric: string; op: "gte" | "lte"; threshold: number }
  | { kind: "severity"; metric: "vulnRepos.worstSeverity"; atLeast: Severity };

export interface MetricSpec {
  metric: string;
  kind: "count" | "severity";
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
}

export interface WidgetAlarm {
  id: string;
  widgetId: string;
  name: string;
  condition: AlarmCondition;
  groupId: string;
  subjectTemplate: string;
  bodyTemplate: string;
  notifyOnRecovery: boolean;
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
}

export interface SecurityNotifySettings {
  enabled: boolean;
  groupId?: string;
  minSeverity: Severity;
  subjectTemplate: string;
  bodyTemplate: string;
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
export const createGroupApi = (name: string) =>
  apiPost<EmailGroup>("/alarms/groups", { name });
/** `force` deletes even when alarms still point at the group. */
export const deleteGroupApi = (id: string, force = false) =>
  apiDelete<{ message: string }>(`/alarms/groups/${id}${force ? "?force=1" : ""}`);
export const addGroupMemberApi = (id: string, email: string) =>
  apiPost<{ message: string }>(`/alarms/groups/${id}/members`, { email });
export const removeGroupMemberApi = (id: string, subscriptionArn: string) =>
  apiDelete<{ message: string }>(
    `/alarms/groups/${id}/members?subscriptionArn=${encodeURIComponent(subscriptionArn)}`);
export const testGroupApi = (id: string) =>
  apiPost<{ message: string }>(`/alarms/groups/${id}/test`, {});

export const fetchSecuritySettings = () => apiGet<SecurityNotifySettings>("/alarms/security");
export const saveSecuritySettingsApi = (data: Partial<SecurityNotifySettings>) =>
  apiPut<SecurityNotifySettings>("/alarms/security", data);

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
  const spec = specs.find(s => s.metric === condition.metric);
  const label = spec?.label ?? condition.metric;
  if (condition.kind === "severity") return `${label} reaches ${condition.atLeast}`;
  const comparator = condition.op === "gte" ? "is at or above" : "is at or below";
  return `${label} ${comparator} ${condition.threshold}${spec?.unit ? ` ${spec.unit}` : ""}`;
}
