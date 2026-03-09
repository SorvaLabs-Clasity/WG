import { apiGet } from "./client";
import { DependencyAlert, DependencySummary } from "../types/Dependabot";
import { mockFetchDependencies, mockFetchDependencySummary } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export async function fetchDependencies(): Promise<DependencyAlert[]> {
  if (DEMO_MODE) return mockFetchDependencies();
  return apiGet<DependencyAlert[]>("/security/dependencies");
}

export async function fetchDependencySummary(): Promise<DependencySummary> {
  if (DEMO_MODE) return mockFetchDependencySummary();
  return apiGet<DependencySummary>("/security/summary");
}
