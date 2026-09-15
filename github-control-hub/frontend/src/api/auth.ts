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
   * exist. This is about whether they are allowed to be used *here*, an
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

/**
 * How somebody qualifies for an admin screen.
 *
 * `"owner"` is the answer that surprises people: an organization owner passes
 * every check in this app by design, whatever team they are on, so that a
 * deleted team cannot lock everyone out of their own settings. Absent on an
 * older backend, which is why the screens that show it check for the string
 * rather than for a falsy value.
 */
export type AdminVia = "owner" | "team" | null;

export interface UserPermissions {
  login: string;
  /** Governs GitHub auto-apply. */
  isControlHubAdmin: boolean;
  controlHubAdminVia?: AdminVia;
  adminTeam: string;
  /** Governs AWS guardrails, a separate team, usually owned by whoever
   *  administers the AWS account rather than the repos. */
  isAwsAdmin: boolean;
  awsAdminVia?: AdminVia;
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
 * Throws when it could not be started. Discarding the response makes a refused
 * profile name, a missing AWS CLI and a failed spawn all produce a button that
 * does nothing, with the reason sitting unread.
 */
export async function triggerAwsSsoLogin(profile?: string): Promise<void> {
  /**
   * Bounded, because the failure this endpoint had was a request that never
   * answered.
   *
   * The backend waits a couple of seconds to see whether the CLI survives
   * starting, so a healthy call is slow enough to be worth naming but nowhere
   * near this. Anything past it is not slowness, it is silence, and silence
   * here shows as a button that did nothing.
   */
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth/aws-sso-login`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ profile }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error("The AWS sign-in did not start — the app stopped waiting after 20 seconds.");
    }
    throw e;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? `Could not start the AWS sign-in (${res.status})`);
  }
}

export interface AwsProfiles {
  profiles: AwsProfile[];
  /** Which file was read, so a surprising answer can be checked. */
  configPath?: string;
  /**
   * Set when the file was readable here but the AWS CLI will refuse it.
   *
   * Distinct from a thrown error: the profiles listed alongside this are real.
   * What it says is that they will not work from a terminal, and why — which is
   * the half nobody can guess from "Unable to parse config file".
   */
  unusable?: string;
  /**
   * Whether `unusable` is something this app can put right.
   *
   * True only for an encoding, where the repair is lossless and needs no
   * guessing. A stray line in the text is left alone: fixing it means deciding
   * what somebody meant by it.
   */
  fixable?: boolean;
}

/** Re-save the AWS config file as plain UTF-8, keeping everything in it. */
export async function repairAwsConfig(): Promise<{
  repaired: { from: string; backup?: string } | null;
  path: string;
  stillUnusable?: string;
}> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-config-repair`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
  });
  const body = await res.json().catch(() => ({} as { error?: string }));
  if (!res.ok) throw new Error(body.error ?? `Could not re-save the AWS config (${res.status})`);
  return body;
}

export async function fetchAwsProfiles(): Promise<AwsProfiles> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-profiles`, { headers: authHeaders() });
  const data = await res.json().catch(() => ({})) as AwsProfiles & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Could not read AWS profiles (${res.status})`);
  }
  return {
    profiles: data.profiles ?? [],
    configPath: data.configPath,
    unusable: data.unusable,
    fixable: data.fixable,
  };
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
 * it is a status rather than an error, the caller keeps asking.
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
}): Promise<{
  profile: string;
  path: string;
  /**
   * Set when the config file had to be re-saved as plain UTF-8 first.
   *
   * A byte-order mark, or UTF-16 from PowerShell, makes the AWS CLI refuse the
   * entire file. Removing it keeps every character — but it is still an edit to
   * somebody's own config, so it is reported rather than done quietly, with
   * where the copy of the original went.
   */
  repaired?: { from: string; backup?: string };
}> {
  const res = await fetch(`${BACKEND_URL}/auth/aws-sso-create-profile`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(p),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not create the profile");
  return body;
}
