import { getToken, setToken } from "./client";

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
    profile: string;
  };
  github: {
    configured: boolean;
    org: string | null;
    /** Why not, when not: secret_missing | secret_incomplete | secret_unreadable. */
    reason?: string;
  };
  /**
   * Whether the GitHub half of the app may be used against the AWS account this
   * app is signed into.
   *
   * Distinct from `github.configured`, which is about whether credentials
   * exist. This is about whether they are allowed to be used *here* — an
   * organization can confine everything GitHub to one account and leave the AWS
   * guardrails running everywhere else.
   */
  githubAccess?: {
    allowed: boolean;
    account?: string;
    expected?: string;
    reason?: "unrestricted" | "match" | "wrong-account" | "unknown-account";
  };
}

export interface AwsProfile {
  name: string;
  type: "sso" | "iam" | "static";
  accountId?: string;
  roleName?: string;
  region?: string;
  ssoStartUrl?: string;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export interface UserPermissions {
  login: string;
  /** Governs GitHub auto-apply. */
  isControlHubAdmin: boolean;
  adminTeam: string;
  /** Governs AWS guardrails — a separate team, usually owned by whoever
   *  administers the AWS account rather than the repos. */
  isAwsAdmin: boolean;
  awsAdminTeam: string;
}

/**
 * Org-wide capabilities only. Per-repo permissions are not reported: those
 * actions run with the user's own GitHub token, so GitHub decides at call time.
 */
export async function fetchUserPermissions(): Promise<UserPermissions> {
  const res = await fetch(`${BACKEND_URL}/auth/permissions`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Failed to fetch permissions");
  return res.json();
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${BACKEND_URL}/auth/status`);
  if (!res.ok) throw new Error("Failed to fetch auth status");
  return res.json();
}

export async function invalidateAws(): Promise<void> {
  await fetch(`${BACKEND_URL}/auth/invalidate-aws`, { method: "POST", headers: authHeaders() });
}

export async function reconnectAws(profile?: string): Promise<AwsSwitchResult> {
  const res = await fetch(`${BACKEND_URL}/auth/reconnect-aws`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ profile }),
  });
  return adoptSession(await res.json());
}

/**
 * Start `aws sso login` for a profile.
 *
 * Throws when it could not be started. This used to discard the response
 * entirely — so a refused profile name, a missing AWS CLI, or a spawn that
 * failed all produced a button that did nothing at all, with the reason sitting
 * unread in a response nobody looked at.
 */
export async function triggerAwsSsoLogin(profile?: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-sso-login`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ profile }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? `Could not start the AWS sign-in (${res.status})`);
  }
}

export async function fetchAwsProfiles(): Promise<AwsProfile[]> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-profiles`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Could not read AWS profiles (${res.status})`);
  }
  return (data as { profiles?: AwsProfile[] }).profiles ?? [];
}

/**
 * What every AWS-switching endpoint returns.
 *
 * `token` is present when the caller was signed in: the session is re-signed
 * with the new account's key, because the old one is not loaded any more. Not
 * adopting it means the very next request is rejected and the user is bounced
 * to the login screen for changing an AWS setting.
 */
export interface AwsSwitchResult {
  ok: boolean;
  reachable: boolean;
  secretsLoaded?: boolean;
  token?: string;
  error?: string;
}

/** Take the re-signed session, if the switch handed one back. */
function adoptSession(result: AwsSwitchResult): AwsSwitchResult {
  if (result?.token) setToken(result.token);
  return result;
}

export async function useAwsProfile(profile: string): Promise<AwsSwitchResult> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-use-profile`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ profile }),
  });
  return adoptSession(await res.json());
}

export async function setAwsAccessKeys(keys: {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}): Promise<AwsSwitchResult> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-access-keys`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(keys),
  });
  return adoptSession(await res.json());
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

// ── Creating an SSO profile, without a terminal ──────────────────────

export interface SsoDeviceAuth {
  clientId: string;
  clientSecret: string;
  deviceCode: string;
  verificationUriComplete: string;
  userCode: string;
  interval: number;
  expiresAt: number;
}

export interface SsoAccount {
  accountId: string;
  accountName: string;
  emailAddress?: string;
  roles: string[];
}

/** Step one: ask AWS to start a sign-in, and get a URL to send the person to. */
export async function startSsoSetup(startUrl: string, ssoRegion: string): Promise<SsoDeviceAuth> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-sso-start`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ startUrl, ssoRegion }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not start the AWS sign-in");
  return body;
}

/**
 * Step two: has it been approved?
 *
 * `pending` is the ordinary answer while somebody is still in their browser, so
 * it is a status rather than an error — the caller keeps asking.
 */
export async function pollSsoSetup(auth: {
  clientId: string; clientSecret: string; deviceCode: string; ssoRegion: string;
}): Promise<{ status: "pending" } | { status: "ready"; accounts: SsoAccount[] }> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-sso-poll`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(auth),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "The AWS sign-in failed");
  return body;
}

/** Step three: write it into ~/.aws/config. */
export async function createSsoProfile(p: {
  profileName: string; startUrl: string; ssoRegion: string;
  accountId: string; roleName: string; region: string;
}): Promise<{ profile: string; path: string }> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-sso-create-profile`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(p),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not create the profile");
  return body;
}
