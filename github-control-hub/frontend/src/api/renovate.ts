import { apiGet, apiPut, apiPost } from "./client";

export interface RenovatePr {
  id: number;
  number: number;
  title: string;
  repo: string;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  ageDays: number;

  /**
   * What decides whether it can be merged. All optional: absent means the
   * detail query did not answer for this one, which is not the same as
   * "nothing blocking", and the panel has to keep them apart.
   */
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

export interface RenovateResponse {
  /** False when no bot account has been named, not an error. */
  configured: boolean;
  prs: RenovatePr[];
  /** GitHub stops paging search at 1,000 results; this says the list is partial. */
  truncated: boolean;
  bot: string | null;
  /** The configured account does not exist or is not visible. */
  unknownBot?: boolean;
  /** The login that actually matched, a GitHub App's carries a [bot] suffix. */
  resolvedBot?: string;
}

/**
 * `details` asks for each open pull request's checks, review and conflicts,
 * which costs a GraphQL batch. The tab count does not need them, and asking
 * anyway made every open of the Vulnerabilities page pay for a view nobody was
 * looking at.
 */
export const fetchRenovate = (details = false) =>
  apiGet<RenovateResponse>(`/security/renovate${details ? "?details=1" : ""}`);
export const setRenovateBot = (bot: string) =>
  apiPut<{ renovateBot: string | null }>("/security/renovate/bot", { bot });

/** How long a closed PR stays visible. Mirrors CLOSED_RETENTION_MONTHS. */
export const CLOSED_RETENTION_MONTHS = 3;

export interface RenovateChange { name: string; from: string; to: string; }

/**
 * What one pull request patches, fetched when somebody expands it.
 *
 * `changes` is null when the body could not be read as a package table, which
 * is not the same as a pull request that changes nothing. The panel keeps them
 * apart and falls back to the changed files.
 */
export const fetchRenovateChanges = (repo: string, number: number) =>
  apiGet<{ changes: RenovateChange[] | null; files: string[] }>(
    `/security/renovate/${encodeURIComponent(repo)}/${number}/changes`);

export type DashboardCategory =
  | "rate-limited" | "errored" | "awaiting-schedule" | "pending-approval"
  | "pr-approval-required" | "group-size-not-met" | "pending-checks"
  | "other" | "open" | "blocked";

export interface DashboardItem {
  action: string;
  category: DashboardCategory;
  branch: string;
  title: string;
  prNumber?: number;
  /** Already requested, so Renovate has been asked and has not run yet. */
  checked: boolean;
}

export interface RepoDashboard {
  repo: string;
  issueNumber: number;
  url: string;
  items: DashboardItem[];
  bulk: { marker: string; checked: boolean }[];
  detectedManifests: number;
  detectedPackages: number;
}

export interface DashboardSweep {
  configured: boolean;
  bot: string | null;
  dashboards: RepoDashboard[];
  /** Bot issues that did not parse as a dashboard. */
  unparsed: number;
}

/**
 * Every repository's Renovate Dependency Dashboard.
 *
 * Self-hosted Renovate has no API: this reads the issue the bot writes, which
 * is the only place its errored, rate-limited and pending work is visible.
 */
export const fetchRenovateDashboards = () =>
  apiGet<DashboardSweep>("/security/renovate/dashboards");

/** The dependency inventory for one repository, read when it is opened. */
export const fetchDetectedDependencies = (repo: string, number: number) =>
  apiGet<{ detected: { ecosystem: string; manifest: string; packages: string[] }[] | null }>(
    `/security/renovate/dashboards/${encodeURIComponent(repo)}/${number}/dependencies`);

/**
 * Tick one checkbox, which is how a self-hosted Renovate is instructed.
 *
 * It acts on its next run rather than now, and the panel says so: a button that
 * looks like it opened a pull request and did not is worse than one that says
 * it queued a request.
 */
export const tickRenovateDashboard = (repo: string, number: number, marker: string) =>
  apiPost<{ ticked: boolean; reason?: string }>(
    `/security/renovate/dashboards/${encodeURIComponent(repo)}/${number}/tick`, { marker });
