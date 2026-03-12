import { apiGet, apiPut } from "./client";
import type { RepoComplianceScore, ComplianceConfig } from "../types/Compliance";
import { mockFetchComplianceDashboard } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export async function fetchComplianceDashboard(): Promise<RepoComplianceScore[]> {
  if (DEMO_MODE) return mockFetchComplianceDashboard();
  return apiGet<RepoComplianceScore[]>("/compliance/dashboard");
}

export async function fetchComplianceConfig(): Promise<ComplianceConfig> {
  return apiGet<ComplianceConfig>("/compliance/config");
}

export async function saveComplianceConfig(config: ComplianceConfig): Promise<ComplianceConfig> {
  return apiPut<ComplianceConfig>("/compliance/config", config);
}
