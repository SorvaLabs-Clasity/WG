import { apiGet, apiPost, apiPut, DEMO_MODE } from "./client";
import { mockFetchActivity, mockUndoActivity, mockRedoActivity, mockRetryActivity, mockGetDetailedLogging, mockUpdateDetailedLogging } from "./mock";
import type { Activity } from "../types/Activity";

export interface ActivityResponse {
  entries: Activity[];
  /** Present when more pages exist. */
  cursor?: string;
  /** False when the server stopped at its read budget rather than the end. */
  exhausted?: boolean;
  examined?: number;
  total?: number;
}

export interface ActivityQuery {
  q?: string;
  source?: string;
  category?: string;
  repoFilter?: string;
  target?: string;
  /** "hide" drops rows written under detailed logging. */
  detailed?: "show" | "hide";
  /** "hide" drops the important events: alerts that also reached the feed. */
  important?: "show" | "hide";
  /** Comma separated kinds to keep. Absent means all of them. */
  importantKinds?: string;
  /**
   * How to treat rows somebody wrote arranging their own board.
   *
   * Absent means all of them, which is what the feed showed before personal
   * widgets and alarms existed.
   */
  personal?: "only" | "hide";
}

/**
 * One page of the feed.
 *
 * Filters go to the server rather than being applied to whatever the browser
 * happened to load. The cursor is opaque and comes back from the previous page;
 * `exhausted: false` means the server stopped early, not that there is nothing
 * more, which are different answers and were being conflated.
 */
export function fetchActivity(
  limit = 50,
  cursor?: string,
  repo?: string,
  query: ActivityQuery = {},
): Promise<ActivityResponse> {
  if (DEMO_MODE) return mockFetchActivity(limit, 0, repo);
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (repo) params.set("repo", repo);
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, String(v));
  return apiGet<ActivityResponse>(`/activity?${params}`);
}

export function undoActivity(
  activityId: string
): Promise<{ undone: string[]; errors: string[] }> {
  if (DEMO_MODE) return mockUndoActivity(activityId);
  return apiPost<{ undone: string[]; errors: string[] }>(`/activity/${activityId}/undo`, {});
}

export function redoActivity(
  activityId: string
): Promise<{ redone: string[]; errors: string[] }> {
  if (DEMO_MODE) return mockRedoActivity(activityId);
  return apiPost<{ redone: string[]; errors: string[] }>(`/activity/${activityId}/redo`, {});
}

export function retryActivity(
  activityId: string
): Promise<{ retried: string[]; errors: string[] }> {
  if (DEMO_MODE) return mockRetryActivity(activityId);
  return apiPost<{ retried: string[]; errors: string[] }>(`/activity/${activityId}/retry`, {});
}

export function undoResolution(
  activityId: string
): Promise<{ success: boolean }> {
  return apiPost<{ success: boolean }>(`/activity/${activityId}/undo-resolution`, {});
}

export interface DetailedLogKind {
  id: string;
  label: string;
  description: string;
  event: string;
}

export interface DetailedLoggingSettings {
  enabled: boolean;
  disabledKinds: string[];
  changedAt?: string;
  changedBy?: string;
}

export interface DetailedLoggingResponse {
  settings: DetailedLoggingSettings;
  kinds: DetailedLogKind[];
}

export function fetchDetailedLogging(): Promise<DetailedLoggingResponse> {
  if (DEMO_MODE) return mockGetDetailedLogging();
  return apiGet<DetailedLoggingResponse>("/activity/detailed-logging");
}

export function updateDetailedLogging(
  settings: { enabled: boolean; disabledKinds: string[] },
): Promise<DetailedLoggingResponse> {
  if (DEMO_MODE) return mockUpdateDetailedLogging(settings);
  return apiPut<DetailedLoggingResponse>("/activity/detailed-logging", settings);
}

export interface PulseBucket {
  start: string;
  github: number;
  aws: number;
  app: number;
  total: number;
}

export interface ActivityPulse {
  buckets: PulseBucket[];
  bucketHours: number;
  total: number;
  byCategory: Record<string, number>;
  topActors: { actor: string; count: number }[];
  topRepos: { repo: string; count: number }[];
  topActions: { action: string; count: number }[];
  byHour: number[];
  /** One entry per calendar day in the window, oldest first. */
  byDay: { date: string; count: number }[];
  /** The zone byHour and byDay were computed in. */
  timeZone: string;
  /** The same window before this one, or null if the walk did not reach it. */
  previousTotal: number | null;
  examined: number;
  /** False means the budget ran out before the window did. Say so. */
  exhausted: boolean;
  oldest?: string;
}

/**
 * The shape of the whole feed, for the header above the table.
 *
 * Unfiltered on purpose: it is the backdrop the filtered table sits in front
 * of, and a chart that narrows with the table stops being a comparison.
 */
export function fetchActivityPulse(hours = 168): Promise<ActivityPulse> {
  if (DEMO_MODE) {
    return Promise.resolve({
      buckets: [], bucketHours: 6, total: 0, byCategory: {},
      topActors: [], topRepos: [], topActions: [],
      byHour: new Array(24).fill(0), byDay: [], timeZone: "UTC",
      previousTotal: null, examined: 0, exhausted: true,
    });
  }
  // The reader's own zone, so "busiest hour" is an hour they recognise rather
  // than one they have to convert. Falls back to UTC on the server if the
  // browser reports something it cannot resolve.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return apiGet<ActivityPulse>(`/activity/pulse?hours=${hours}&tz=${encodeURIComponent(tz)}`);
}
