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
  aws: {
    connected: boolean;
    dynamoReachable: boolean;
    region: string;
    accountId: string | null;
    identity: string | null;
    profile: string;
  };
  github: { configured: boolean; org: string | null };
}

export interface AwsProfile {
  name: string;
  type: "sso" | "iam" | "static";
  accountId?: string;
  roleName?: string;
  region?: string;
  ssoStartUrl?: string;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BACKEND_URL}/auth/status`);
  if (!res.ok) throw new Error("Failed to fetch auth status");
  return res.json();
}

export async function invalidateAws(): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/invalidate-aws`, { method: "POST" });
}

export async function reconnectAws(profile?: string): Promise<{ ok: boolean; reachable: boolean }> {
  const res = await fetch(`${BACKEND_URL}/auth/reconnect-aws`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  return res.json();
}

export async function triggerAwsSsoLogin(profile?: string): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/aws-sso-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
}

export async function fetchAwsProfiles(): Promise<AwsProfile[]> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-profiles`);
  const data = await res.json();
  return data.profiles || [];
}

export async function useAwsProfile(profile: string): Promise<{ ok: boolean; reachable: boolean }> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-use-profile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  });
  return res.json();
}

export async function setAwsAccessKeys(keys: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}): Promise<{ ok: boolean; reachable: boolean }> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-access-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(keys),
  });
  return res.json();
}

export async function verifyStoredToken(token: string): Promise<{ valid: boolean; login?: string; avatarUrl?: string }> {
  try {
    const res = await fetch(`${BACKEND_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.json();
  } catch {
    return { valid: false };
  }
}

export async function revokeGithub(token: string): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/revoke-github`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}
