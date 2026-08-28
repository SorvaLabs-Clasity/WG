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
