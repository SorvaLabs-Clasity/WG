import { apiGet, apiPost } from "./client";

export interface ConfigBundle {
  format: number;
  exportedAt: string;
  exportedBy: string;
  org: string | null;
  counts: Record<string, number>;
  [key: string]: unknown;
}

export interface ImportResult {
  dryRun: boolean;
  applied: Record<string, number>;
  errors: string[];
  from: { org: string | null; exportedAt: string | null };
}

export function exportConfig(): Promise<ConfigBundle> {
  return apiGet<ConfigBundle>("/config/export");
}

export function importConfig(bundle: unknown, dryRun: boolean): Promise<ImportResult> {
  return apiPost<ImportResult>(`/config/import?dryRun=${dryRun}`, bundle);
}
