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
}

export interface RenovateResponse {
  /** False when no bot account has been named — not an error. */
  configured: boolean;
  prs: RenovatePr[];
  /** GitHub stops paging search at 1,000 results; this says the list is partial. */
  truncated: boolean;
  bot: string | null;
  /** The configured account does not exist or is not visible. */
  unknownBot?: boolean;
  /** The login that actually matched — a GitHub App's carries a [bot] suffix. */
  resolvedBot?: string;
}

export const fetchRenovate = () => apiGet<RenovateResponse>("/security/renovate");
export const setRenovateBot = (bot: string) =>
  apiPut<{ renovateBot: string | null }>("/security/renovate/bot", { bot });

/** How long a closed PR stays visible. Mirrors CLOSED_RETENTION_MONTHS. */
export const CLOSED_RETENTION_MONTHS = 3;
