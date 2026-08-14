import { apiGet, apiPost } from "./client";
import { DependencyAlert, DependencySummary } from "../types/Dependabot";
import { mockFetchDependencies, mockFetchDependencySummary } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export async function fetchDependencies(): Promise<DependencyAlert[]> {
  if (DEMO_MODE) return mockFetchDependencies();
  return apiGet<DependencyAlert[]>("/security/dependencies");
}

/**
 * One repository's alerts, rather than the whole organization.
 *
 * Costs one or two GitHub requests instead of one per repository, which is
 * what makes it usable after every toggle.
 */
export async function fetchDependenciesForRepo(repo: string): Promise<DependencyAlert[]> {
  if (DEMO_MODE) return (await mockFetchDependencies()).filter(d => d.repo === repo);
  return apiGet<DependencyAlert[]>(`/security/dependencies?repo=${encodeURIComponent(repo)}`);
}

export async function enableDependabot(repo: string): Promise<{ success: boolean }> {
  if (DEMO_MODE) return { success: true };
  return apiPost<{ success: boolean }>("/security/dependencies/enable", { repo });
}

export async function disableDependabot(repo: string): Promise<{ success: boolean }> {
  if (DEMO_MODE) return { success: true };
  return apiPost<{ success: boolean }>("/security/dependencies/disable", { repo });
}

export async function fetchDependencySummary(): Promise<DependencySummary> {
  if (DEMO_MODE) return mockFetchDependencySummary();
  return apiGet<DependencySummary>("/security/summary");
}
