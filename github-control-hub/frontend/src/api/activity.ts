import { apiGet, DEMO_MODE } from "./client";
import { mockFetchActivity } from "./mock";
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
