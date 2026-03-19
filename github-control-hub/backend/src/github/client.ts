import { Octokit } from "octokit";

// ── GitHub App Token Manager ──

/** Normalize PEM key — Secrets Manager's key/value editor strips newlines. */
function normalizePemKey(key: string): string {
  // Replace literal \n strings with actual newlines
  let normalized = key.replace(/\\n/g, "\n").trim();

  // If the key already has proper newlines, return as-is
  if (normalized.split("\n").length > 3) return normalized;

  // Key is a single line (newlines stripped by Secrets Manager UI) — reconstruct PEM format
  const match = normalized.match(/-----BEGIN (.+?)-----(.+?)-----END (.+?)-----/);
  if (match) {
    const type = match[1];
    const base64 = match[2].replace(/\s/g, "");
    const lines = base64.match(/.{1,64}/g) || [];
    return `-----BEGIN ${type}-----\n${lines.join("\n")}\n-----END ${type}-----\n`;
  }

  return normalized;
}

let tokenManager: GitHubTokenManager | null = null;

class GitHubTokenManager {
  private cachedToken = "";
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private auth: any;

  async init(appId: string, privateKey: string, installationId: string) {
    // Use indirect import to prevent tsc from converting dynamic import() to require()
    // @octokit/auth-app is ESM-only and cannot be require()'d
    const { createAppAuth } = await (new Function('specifier', 'return import(specifier)'))("@octokit/auth-app");
    this.auth = createAppAuth({
      appId,
      privateKey: normalizePemKey(privateKey),
      installationId: Number(installationId),
    });
    await this.getTokenAsync(); // eagerly fetch first token
  }

  getToken(): string {
    return this.cachedToken || process.env.SYSTEM_GITHUB_TOKEN || "";
  }

  async getTokenAsync(): Promise<string> {
    // Return cached token if still valid (with 5-min buffer)
    if (this.cachedToken && Date.now() < this.expiresAt - 5 * 60 * 1000) {
      return this.cachedToken;
    }
    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async _refresh(): Promise<string> {
    const result = await this.auth({ type: "installation" });
    this.cachedToken = result.token;
    this.expiresAt = new Date(result.expiresAt!).getTime();
    console.log(`[TokenManager] GitHub App token refreshed, expires at ${result.expiresAt}`);
    return result.token;
  }
}

/** Initialize the GitHub App token manager. Call once at startup. */
export async function initTokenManager(appId: string, privateKey: string, installationId: string): Promise<void> {
  tokenManager = new GitHubTokenManager();
  await tokenManager.init(appId, privateKey, installationId);
}

/** Sync getter — returns cached App token or falls back to SYSTEM_GITHUB_TOKEN env var. */
export function getSystemToken(): string {
  return tokenManager?.getToken() || process.env.SYSTEM_GITHUB_TOKEN || "";
}

/** Async getter — refreshes App token if expired, falls back to SYSTEM_GITHUB_TOKEN env var. */
export async function getSystemTokenAsync(): Promise<string> {
  if (tokenManager) return tokenManager.getTokenAsync();
  return process.env.SYSTEM_GITHUB_TOKEN || "";
}

// ── Octokit Factory ──

export function createOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    retry: { enabled: true, retries: 1 },
    throttle: {
      onRateLimit: () => false,
      onSecondaryRateLimit: () => false,
    },
  });
}

export function getOrg(): string {
  const org = process.env.GITHUB_ORG;
  if (!org) throw new Error("GITHUB_ORG environment variable is required");
  return org;
}

export async function checkAuditLogAccess(octokit: Octokit): Promise<boolean> {
  const org = getOrg();
  try {
    // Attempt to fetch 1 item from the audit log
    await octokit.request("GET /orgs/{org}/audit-log", {
      org,
      per_page: 1,
    });
    return true;
  } catch (error: any) {
    if (error.status === 403 || error.status === 404) {
      return false;
    }
    // If it fails for another reason (e.g., network error), we might log it,
    // but we can assume false or re-throw. Assuming false for safety.
    console.error("Error checking audit log access:", error);
    return false;
  }
}

/** Org audit log event shape (GitHub API). */
export interface OrgAuditLogEvent {
  "@timestamp"?: number;
  action?: string;
  actor?: string;
  actor_id?: number;
  user?: string;
  org?: string;
  repo?: string;
  created_at?: number;
  data?: Record<string, unknown>;
}

/** Fetch recent org audit log events (Enterprise / orgs with audit log). */
export async function fetchOrgAuditLog(
  octokit: Octokit,
  options: { per_page?: number; page?: number; phrase?: string } = {}
): Promise<OrgAuditLogEvent[]> {
  const org = getOrg();
  const res = await octokit.request("GET /orgs/{org}/audit-log", {
    org,
    per_page: options.per_page ?? 50,
    page: options.page ?? 1,
    phrase: options.phrase,
    order: "desc",
  });
  return (res.data as OrgAuditLogEvent[]) || [];
}
