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

// ── many repositories at once ──

export type BulkAction = "alerts-on" | "alerts-off" | "fixes-on" | "fixes-off";

export interface BulkResult {
  repo: string;
  ok: boolean;
  error?: string;
  rateLimited?: boolean;
}

export interface BulkSummary {
  results: BulkResult[];
  changed: number;
  failed: number;
  /** Whole seconds the run spent waiting because GitHub asked it to. */
  sleptSeconds: number;
}

/**
 * One request for the whole selection, not one per repository.
 *
 * The pacing that keeps GitHub from refusing a burst of writes lives on the
 * server, where the response headers that ask for it arrive. A loop here would
 * be the burst.
 */
export function bulkDependabot(repos: string[], action: BulkAction): Promise<BulkSummary> {
  return apiPost<BulkSummary>("/security/dependencies/bulk", { repos, action });
}

/**
 * When the stored view was computed, so the tab can say how old it is.
 *
 * Null means nothing is stored yet, which is a first open rather than an old
 * answer, and the page says so differently.
 */
export function fetchDependenciesAge(): Promise<{ computedAt: string | null; fresh: boolean }> {
  return apiGet<{ computedAt: string | null; fresh: boolean }>("/security/dependencies/age");
}

/**
 * Open Dependabot pull requests per repository.
 *
 * `counts` is null when the search could not be made. Callers must keep that
 * apart from an empty object: no open pull requests anywhere and nobody having
 * looked render identically and mean opposite things.
 */
export function fetchDependabotPrCounts(): Promise<{ counts: Record<string, number> | null }> {
  return apiGet<{ counts: Record<string, number> | null }>("/security/dependencies/fix-prs");
}
