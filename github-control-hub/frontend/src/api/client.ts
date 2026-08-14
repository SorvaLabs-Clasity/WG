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

/**
 * A rate limit is not a failure of the thing you asked for — it is the whole
 * app being unable to read GitHub for a while. Carrying the reset time on the
 * error lets the banner count down instead of just saying "try again".
 */
export class RateLimitError extends Error {
  constructor(
    message: string,
    readonly resetAt?: string,
    readonly retryAfter?: number,
    readonly kind: "primary" | "secondary" = "primary",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    clearToken();
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  // Removed from the org mid-session. Every subsequent request would fail the
  // same way, so end the session here rather than letting the app fill with
  // identical errors.
  if (res.status === 403) {
    const body = await res.json().catch(() => ({})) as { error?: string; code?: string };
    if (body.code === "ORG_MEMBERSHIP_REVOKED") {
      clearToken();
      window.location.href = `/login?auth_error=not_member`;
      throw new Error(body.error ?? "No longer an organization member");
    }
    throw new Error(body.error ?? `Request failed: ${res.status}`);
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
  if (res.status === 429) {
    const body = await res.json().catch(() => ({})) as {
      error?: string; resetAt?: string; retryAfter?: number; kind?: "primary" | "secondary";
    };
    throw new RateLimitError(
      body.error ?? "GitHub rate limit reached.",
      body.resetAt, body.retryAfter, body.kind ?? "primary",
    );
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
