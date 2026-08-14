import { apiGet } from "./client";

export interface RepoUsage {
  repo: string;
  unattributed: boolean;
  quantity: number;
  unitType: string;
  gross: number;
  net: number;
  products: string[];
}

export interface UsageSummary {
  months: { month: string; quantity: number; gross: number; net: number }[];
  byRepo: RepoUsage[];
  byProduct: { product: string; quantity: number; unitType: string; gross: number; net: number }[];
  totals: { quantity: number; gross: number; net: number; repos: number };
  empty: boolean;
}

export const fetchUsage = (months = 6) => apiGet<UsageSummary>(`/billing/usage?months=${months}`);
