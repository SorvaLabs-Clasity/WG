import { apiGet } from "./client";
import { RepoComplianceScore } from "../types/Compliance";
import { mockFetchComplianceDashboard } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export async function fetchComplianceDashboard(): Promise<RepoComplianceScore[]> {
  if (DEMO_MODE) return mockFetchComplianceDashboard();
  return apiGet<RepoComplianceScore[]>("/compliance/dashboard");
}
