import { apiGet, apiPost, DEMO_MODE } from "./client";
import { mockFetchActivity, mockUndoActivity, mockRedoActivity, mockRetryActivity } from "./mock";
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

export function resolveConflict(
  activityId: string,
  resolution: "override" | "skip"
): Promise<{ resolved: boolean; resolution: string }> {
  return apiPost<{ resolved: boolean; resolution: string }>(`/activity/${activityId}/resolve-conflict`, { resolution });
}
