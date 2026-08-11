import { apiGet, apiPost, apiPut, apiDelete } from "./client";

export type GuardrailMode = "report" | "enforce";

export interface ParamSpec {
  key: string;
  label: string;
  help?: string;
  type: "number" | "boolean" | "text" | "ports" | "choice";
  default: any;
  allowed?: number[];
  options?: { value: string; label: string }[];
  unit?: string;
  min?: number;
}

export interface CatalogEntry {
  kind: string;
  /** Human title — `kind` is an internal identifier and should not be shown. */
  title: string;
  summary: string;
  paramSchema: ParamSpec[];
  resourceType: string;
  defaultMode: GuardrailMode;
  defaultParams: Record<string, any>;
  triggerEvents: string[];
  /** False for kinds whose remediation could cut live access — report-only. */
  canRemediate: boolean;
}

export interface Guardrail {
  id: string;
  name: string;
  description: string;
  kind: string;
  enabled: boolean;
  mode: GuardrailMode;
  applyOnCreate: boolean;
  params: Record<string, any>;
  exclusionLists: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Finding {
  ruleId: string;
  ruleName: string;
  kind: string;
  resourceId: string;
  resourceType: string;
  verdict: "compliant" | "violation" | "not_applicable";
  summary: string;
  proposedFix?: string;
  /** Region the resource lives in, used to build the AWS console link. */
  region?: string;
  excluded: boolean;
  excludedBy?: string;
  remediated: boolean;
  error?: string;
  checkedAt: string;
}

export interface AwsExclusionList {
  id: string;
  name: string;
  description: string;
  resources: string[];
  patterns: { id: string; type: "starts_with" | "contains" | "tag_equals"; value: string }[];
  whitelist: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunResult {
  trigger: string;
  findings: Finding[];
  remediated: number;
  violations: number;
  excluded: number;
  errors: string[];
}

export const fetchCatalog = () => apiGet<CatalogEntry[]>("/aws/catalog");
export const fetchGuardrails = () => apiGet<Guardrail[]>("/aws/guardrails");
export const createGuardrail = (body: Partial<Guardrail>) => apiPost<Guardrail>("/aws/guardrails", body);
export const updateGuardrail = (id: string, body: Partial<Guardrail>) => apiPut<Guardrail>(`/aws/guardrails/${id}`, body);
export const deleteGuardrail = (id: string) => apiDelete<{ message: string }>(`/aws/guardrails/${id}`);

export const fetchFindings = () => apiGet<Finding[]>("/aws/findings");
export const runGuardrails = (body: { ruleIds?: string[]; resourceIds?: string[] }) =>
  apiPost<RunResult>("/aws/run", body);
export const previewGuardrails = (body: { ruleIds?: string[]; resourceIds?: string[] }) =>
  apiPost<RunResult>("/aws/preview", body);

export const fetchAwsExclusions = () => apiGet<AwsExclusionList[]>("/aws/exclusions");
export const createAwsExclusion = (body: Partial<AwsExclusionList>) => apiPost<AwsExclusionList>("/aws/exclusions", body);
export const updateAwsExclusion = (id: string, body: Partial<AwsExclusionList>) =>
  apiPut<AwsExclusionList>(`/aws/exclusions/${id}`, body);
export const deleteAwsExclusion = (id: string) => apiDelete<{ message: string }>(`/aws/exclusions/${id}`);
