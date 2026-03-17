const BASE_URL = import.meta.env.VITE_API_URL || "/api";

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

export function getToken(): string | null {
  return sessionStorage.getItem("gh_hub_token");
}

export function setToken(token: string): void {
  sessionStorage.setItem("gh_hub_token", token);
}

export function clearToken(): void {
  sessionStorage.removeItem("gh_hub_token");
  localStorage.removeItem("gh_hub_user");
}

export interface GhUserInfo {
  login: string;
  avatarUrl: string;
}

export function setUserInfo(info: GhUserInfo): void {
  localStorage.setItem("gh_hub_user", JSON.stringify(info));
}

export function getUserInfo(): GhUserInfo | null {
  const raw = localStorage.getItem("gh_hub_user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function isAuthenticated(): boolean {
  if (DEMO_MODE) return true;
  return !!getToken();
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (res.status === 503) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    if (body.code === "AWS_SESSION_EXPIRED") {
      clearToken();
      window.location.href = "/login";
      throw new Error("AWS session expired");
    }
    throw new Error(body.error ?? "Service temporarily unavailable");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 1
): Promise<Response> {
  let res = await fetch(url, options);
  if (res.status === 503 && retries > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await fetch(url, options);
  }
  return res;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  return handleResponse<T>(res);
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}

export async function apiPut<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(res);
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  return handleResponse<T>(res);
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetchWithRetry(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(body),
  });
  return handleResponse<T>(res);
}
