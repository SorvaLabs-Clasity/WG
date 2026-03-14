import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import {
  mockFetchRuleTemplates,
  mockCreateRuleTemplate,
  mockUpdateRuleTemplate,
  mockDeleteRuleTemplate,
} from "./mock";
import type { RuleTemplate, RuleTemplateType } from "../types/RuleTemplate";

export function fetchRuleTemplates(): Promise<RuleTemplate[]> {
  if (DEMO_MODE) return mockFetchRuleTemplates();
  return apiGet<RuleTemplate[]>("/rule-templates");
}

export function createRuleTemplate(data: {
  name: string;
  description: string;
  ruleType: RuleTemplateType;
  branchProtection?: any;
  tagProtection?: any;
  pushProtection?: any;
}): Promise<RuleTemplate> {
  if (DEMO_MODE) return mockCreateRuleTemplate(data);
  return apiPost<RuleTemplate>("/rule-templates", data);
}

export function updateRuleTemplate(
  id: string,
  data: Partial<{
    name: string;
    description: string;
    ruleType: RuleTemplateType;
    branchProtection?: any;
    tagProtection?: any;
    pushProtection?: any;
  }>
): Promise<RuleTemplate> {
  if (DEMO_MODE) return mockUpdateRuleTemplate(id, data);
  return apiPut<RuleTemplate>(`/rule-templates/${id}`, data);
}

export function deleteRuleTemplateApi(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteRuleTemplate(id);
  return apiDelete<{ message: string }>(`/rule-templates/${id}`);
}
