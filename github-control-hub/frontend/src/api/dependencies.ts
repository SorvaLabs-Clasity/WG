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

export type BulkAction = "alerts-on" | "alerts-off" | "fixes-on" | "fixes-off" | "retrigger";

export interface BulkResult {
  repo: string;
  ok: boolean;
  error?: string;
  rateLimited?: boolean;
}

export interface BulkSummary {
  /**
   * Repositories left with security updates switched off by a re-trigger that
   * could not switch them back on. Named rather than only counted: this is the
   * one outcome that leaves things worse than it found them.
   */
  leftOff: number;
  leftOffRepos: string[];
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
export function fetchDependenciesAge(): Promise<{
  computedAt: string | null;
  fresh: boolean;
  /** True while a background sweep is actually running. */
  refreshing: boolean;
  /** False when the sweep cannot be kept between openings. */
  storing: boolean;
  /** Why not, in words, when it cannot. */
  problem: string | null;
}> {
  return apiGet("/security/dependencies/age");
}

export interface DependabotPr {
  id: number;
  number: number;
  repo: string;
  title: string;
  url: string;
  draft: boolean;
  createdAt: string;
  ageDays: number;
  /** The package it bumps, where its branch says so. Null for grouped ones. */
  packageName?: string | null;

  /** All optional: absent means the detail query did not answer for this one. */
  checks?: string | null;
  reviewDecision?: string | null;
  mergeable?: string | null;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  headRefName?: string;
  labels?: string[];
  readiness?: "ready" | "failing" | "conflicting" | "waiting" | "unknown";
}

/**
 * Open Dependabot pull requests, and how many each repository has.
 *
 * Both are null when the search could not be made. Callers must keep that
 * apart from an empty list: no open pull requests anywhere and nobody having
 * looked render identically and mean opposite things.
 */
export function fetchDependabotPrs(): Promise<{
  counts: Record<string, number> | null;
  prs: DependabotPr[] | null;
}> {
  return apiGet("/security/dependencies/fix-prs");
}

export type RolloutOutcome =
  | "opened" | "committed" | "already-configured" | "no-ecosystem" | "failed";

export interface RolloutSummary {
  results: {
    repo: string; outcome: RolloutOutcome; url?: string; detail?: string;
    /** The file landed but will do nothing until the switch is on. */
    warning?: string;
  }[];
  opened: number;
  committed: number;
  skipped: number;
  failed: number;
}

/**
 * Write .github/dependabot.yml into repositories to switch on grouped security
 * updates, which is the one thing GitHub documents as immediately retrying
 * every open alert that has a patch.
 */
export function rolloutDependabotConfig(
  repos: string[], mode: "pr" | "commit",
): Promise<RolloutSummary> {
  return apiPost<RolloutSummary>("/security/dependencies/config", { repos, mode });
}
