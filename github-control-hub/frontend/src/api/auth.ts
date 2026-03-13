const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL !== undefined && import.meta.env.VITE_BACKEND_URL !== ""
    ? import.meta.env.VITE_BACKEND_URL
    : import.meta.env.PROD
      ? ""
      : "http://localhost:4000";

export function getLoginUrl(): string {
  return `${BACKEND_URL}/auth/github`;
}

export interface AuthStatus {
  aws: { connected: boolean; dynamoReachable: boolean; region: string };
  github: { configured: boolean; org: string | null };
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BACKEND_URL}/auth/status`);
  if (!res.ok) throw new Error("Failed to fetch auth status");
  return res.json();
}

export async function invalidateAws(): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/invalidate-aws`, { method: "POST" });
}

export async function reconnectAws(): Promise<{ ok: boolean; reachable: boolean }> {
  const res = await fetch(`${BACKEND_URL}/auth/reconnect-aws`, { method: "POST" });
  return res.json();
}

export async function triggerAwsSsoLogin(): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/aws-sso-login`, { method: "POST" });
}

export async function revokeGithub(token: string): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/revoke-github`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
