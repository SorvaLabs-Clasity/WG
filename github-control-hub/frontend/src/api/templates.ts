import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import {
  mockFetchTemplates,
  mockCreateTemplate,
  mockUpdateTemplate,
  mockDeleteTemplate,
  mockApplyTemplate,
} from "./mock";
import type { RepoTemplate, BranchRule } from "../types/Template";

export function fetchTemplates(): Promise<RepoTemplate[]> {
  if (DEMO_MODE) return mockFetchTemplates();
  return apiGet<RepoTemplate[]>("/templates");
}

export function createTemplate(data: {
  name: string;
  description: string;
  branches: BranchRule[];
  autoApplyOnNewRepo: boolean;
}): Promise<RepoTemplate> {
  if (DEMO_MODE) return mockCreateTemplate(data);
  return apiPost<RepoTemplate>("/templates", data);
}

export function updateTemplate(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    branches: BranchRule[];
    autoApplyOnNewRepo: boolean;
  }>
): Promise<RepoTemplate> {
  if (DEMO_MODE) return mockUpdateTemplate(id, data);
  return apiPut<RepoTemplate>(`/templates/${id}`, data);
}

export function deleteTemplateApi(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteTemplate(id);
  return apiDelete<{ message: string }>(`/templates/${id}`);
}

export function applyTemplate(
  templateId: string,
  repo: string
): Promise<{ created: string[]; protected: string[]; errors: string[] }> {
  if (DEMO_MODE) return mockApplyTemplate(templateId, repo);
  return apiPost(`/templates/${templateId}/apply/${repo}`, {});
}
