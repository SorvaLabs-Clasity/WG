import { apiGet, apiPost, apiPut, apiDelete, DEMO_MODE } from "./client";
import { mockFetchScanners, mockCreateScanner, mockUpdateScanner, mockDeleteScanner, mockGetScanResult, mockRunScan } from "./mock";
import type { Scanner, ScanResult } from "../types/Scanner";

export function fetchScanners(): Promise<Scanner[]> {
  if (DEMO_MODE) return mockFetchScanners();
  return apiGet<Scanner[]>("/scanners");
}

export function createScanner(data: Omit<Scanner, "id" | "createdAt" | "updatedAt">): Promise<Scanner> {
  if (DEMO_MODE) return mockCreateScanner(data);
  return apiPost<Scanner>("/scanners", data);
}

export function updateScanner(id: string, data: Partial<Omit<Scanner, "id" | "createdAt" | "updatedAt">>): Promise<Scanner> {
  if (DEMO_MODE) return mockUpdateScanner(id, data);
  return apiPut<Scanner>(`/scanners/${id}`, data);
}

export function deleteScanner(id: string): Promise<{ message: string }> {
  if (DEMO_MODE) return mockDeleteScanner(id);
  return apiDelete(`/scanners/${id}`);
}

export function fetchScanResult(id: string): Promise<ScanResult> {
  if (DEMO_MODE) return mockGetScanResult(id);
  return apiGet<ScanResult>(`/scanners/${id}/results`);
}

export function runScan(id: string): Promise<ScanResult> {
  if (DEMO_MODE) return mockRunScan(id);
  return apiPost<ScanResult>(`/scanners/${id}/run`, {});
}
