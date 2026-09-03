import { apiGet, apiPut } from "./client";

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
