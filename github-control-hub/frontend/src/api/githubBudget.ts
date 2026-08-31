import { apiGet } from "./client";

export type Bucket = "core" | "search" | "graphql";

export interface BudgetLimit {
  bucket: Bucket;
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
  window: string;
}

/** What a feature is. Reference material; it carries no numbers. */
export interface FeatureNote {
  feature: string;
  trigger: string;
  endpoints: string[];
  /** Where in the codebase the requests are made. */
  files: string[];
  scalesWith: string;
  note?: string;
}

export interface UsageRow {
  feature: string;
  bucket: Bucket;
  count: number;
  /** Share of everything measured in this window, 0 to 1. */
  share: number;
  /** Absent for a label nobody has written up yet. */
  about?: FeatureNote;
}

export interface BudgetReport {
  limits: BudgetLimit[];
  usage: UsageRow[];
  totals: Record<Bucket, number>;
  hours: string[];
  /** Nothing recorded yet, as distinct from nothing having happened. */
  empty: boolean;
  error?: string;
  cached: boolean;
}

export const fetchGithubBudget = (hours = 1) =>
  apiGet<BudgetReport>(`/github-budget?hours=${hours}`);
