import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
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
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function fetchWidgets(): Promise<WidgetConfig[]> {
  if (DEMO_MODE) return mockFetchWidgets();
  return apiGet<WidgetConfig[]>("/widgets");
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
