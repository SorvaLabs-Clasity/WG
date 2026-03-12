import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import {
  mockFetchExclusions,
  mockCreateExclusion,
  mockUpdateExclusion,
  mockDeleteExclusion,
} from "./mock";
import type { ExclusionList } from "../types/Template";

export function fetchExclusions(): Promise<ExclusionList[]> {
  if (DEMO_MODE) return mockFetchExclusions();
  return apiGet<ExclusionList[]>("/exclusions");
}

export function createExclusion(data: {
  name: string;
  description: string;
  repos: string[];
  forceTemplateIds: string[];
  forceOnNewTemplates: boolean;
}): Promise<ExclusionList> {
  if (DEMO_MODE) return mockCreateExclusion(data);
  return apiPost<ExclusionList>("/exclusions", data);
}

export function updateExclusion(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    repos: string[];
    forceTemplateIds: string[];
    forceOnNewTemplates: boolean;
  }>
): Promise<ExclusionList> {
  if (DEMO_MODE) return mockUpdateExclusion(id, data);
  return apiPut<ExclusionList>(`/exclusions/${id}`, data);
}

export function deleteExclusionApi(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteExclusion(id);
  return apiDelete<{ message: string }>(`/exclusions/${id}`);
}
