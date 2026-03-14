import { apiGet, apiPost } from "./client";
import { SecurityAlert } from "../types/Alert";
import { mockFetchAlerts, mockResolveAlert, mockUnresolveAlert } from "./mock";

const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export async function fetchAlerts(): Promise<SecurityAlert[]> {
  if (DEMO_MODE) return mockFetchAlerts();
  return apiGet<SecurityAlert[]>("/alerts");
}

export async function resolveAlert(id: string): Promise<SecurityAlert> {
  if (DEMO_MODE) return mockResolveAlert(id);
  return apiPost<SecurityAlert>(`/alerts/${id}/resolve`, {});
}

export async function unresolveAlert(id: string): Promise<SecurityAlert> {
  if (DEMO_MODE) return mockUnresolveAlert(id);
  return apiPost<SecurityAlert>(`/alerts/${id}/unresolve`, {});
}

export async function simulateAlert(scenario: string): Promise<void> {
  if (DEMO_MODE) {
    // In demo mode, we just hit the real backend anyway if it's running, 
    // or just console log since mockStore doesn't have an easy way to trigger from here without refactoring.
    // Let's just make the API call. If backend is not running, it will fail, but demo mode usually runs with the backend.
  }
  return apiPost<{ message: string }>("/alerts/simulate", { scenario }).then(() => {});
}

export async function fetchInactiveUsers(): Promise<{ username: string, lastActive: string, role: string }[]> {
  return apiGet<{ username: string, lastActive: string, role: string }[]>("/alerts/inactive-users");
}
