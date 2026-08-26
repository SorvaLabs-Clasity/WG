import { apiGet, apiPost, apiPut, DEMO_MODE } from "./client";
import { mockFetchActivity, mockUndoActivity, mockRedoActivity, mockRetryActivity, mockGetDetailedLogging, mockUpdateDetailedLogging } from "./mock";
import type { Activity } from "../types/Activity";

interface ActivityResponse {
  entries: Activity[];
  total: number;
}

export function fetchActivity(
  limit = 50,
  offset = 0,
  repo?: string
): Promise<ActivityResponse> {
  if (DEMO_MODE) return mockFetchActivity(limit, offset, repo);
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (repo) params.set("repo", repo);
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
