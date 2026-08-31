import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import type { WidgetFilter } from "../lib/widgetFilters";
import {
  mockFetchWidgets,
  mockCreateWidget,
  mockUpdateWidget,
  mockDeleteWidget,
} from "./mock";

export interface WidgetConfig {
  id: string;
  title: string;
  type: "preset" | "query";
  presetId?: string;
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: any;
  displayType: "metric" | "table";
  /** Per-column filters, on a personal widget. See lib/widgetFilters.ts. */
  filters?: WidgetFilter[];
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WidgetSnapshot {
  widgetId: string;
  rows: any[];
  /** How many rows the check produced, before any trimming for size. */
  total: number;
  /** True when `rows` holds fewer than `total`, the count is still exact. */
  trimmed: boolean;
  /**
   * Repositories in the organization when this was computed. Present so a card
   * can draw its share on the first paint instead of waiting on the repository
   * listing, which arrives seconds later and repaints the card when it does.
   */
  repoTotal?: number;
  /** Set when the check could not complete on the last pass. */
  error?: string;
  computedAt: string;
}

/**
 * What every widget last worked out, computed on the schedule rather than now.
 *
 * One request for the whole dashboard. Empty is a normal answer, the scheduled
 * pass may not have run yet, and the caller falls back to computing live.
 */
export function fetchWidgetSnapshots(): Promise<WidgetSnapshot[]> {
  if (DEMO_MODE) return Promise.resolve([]);
  return apiGet<WidgetSnapshot[]>("/widgets/snapshots");
}

/**
 * The shared board by default, or the caller's own.
 *
 * Two boards out of one endpoint. Passing nothing returns what it always
 * returned, so the Overview tab does not change because personal ones exist.
 */
export function fetchWidgets(scope?: "personal"): Promise<WidgetConfig[]> {
  if (DEMO_MODE) return mockFetchWidgets();
  return apiGet<WidgetConfig[]>(scope ? `/widgets?scope=${scope}` : "/widgets");
}

export function createWidgetApi(data: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">): Promise<WidgetConfig> {
  if (DEMO_MODE) return mockCreateWidget(data);
  return apiPost<WidgetConfig>("/widgets", data);
}

export function updateWidgetApi(id: string, data: Partial<Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">>): Promise<WidgetConfig> {
  if (DEMO_MODE) return mockUpdateWidget(id, data);
  return apiPut<WidgetConfig>(`/widgets/${id}`, data);
}

export function deleteWidgetApi(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteWidget(id);
  return apiDelete<{ message: string }>(`/widgets/${id}`);
}
