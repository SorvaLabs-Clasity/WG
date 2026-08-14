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

/** The one export we need from @octokit/auth-app, however it is loaded. */
export type CreateAppAuth = (opts: { appId: string; privateKey: string; installationId: number }) => any;

let tokenManager: GitHubTokenManager | null = null;

/** Refresh this long before expiry, and treat a token inside the window as stale. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

class GitHubTokenManager {
  private cachedToken = "";
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private auth: any;

  async init(appId: string, privateKey: string, installationId: string, createAppAuthFn?: CreateAppAuth) {
    // Two ways in, because two builds load this file.
    //
    // The desktop runs tsc's CommonJS output, where a plain `await import()`
    // would be rewritten to require() — fatal for an ESM-only package. Hence
    // require.resolve plus a dynamic import built with `new Function`, which
    // tsc cannot see through.
    //
    // A bundled build cannot use that path at all: esbuild inlines the package
    // and there is no file on disk for require.resolve to find, so it throws
    // "Cannot find module '@octokit/auth-app'". Those callers pass the factory
    // in from a static import the bundler can follow. See webhooks/worker.ts.
    const createAppAuth = createAppAuthFn ?? await (async () => {
      const resolved = require.resolve("@octokit/auth-app");
      const mod = await (new Function('specifier', 'return import(specifier)'))("file://" + resolved);
      return mod.createAppAuth as CreateAppAuth;
    })();
    this.auth = createAppAuth({
      appId,
      privateKey: normalizePemKey(privateKey),
      installationId: Number(installationId),
    });
    await this.getTokenAsync(); // eagerly fetch first token
  }

  /** Cached token present and not yet inside the expiry buffer. */
  private isFresh(): boolean {
    return !!this.cachedToken && Date.now() < this.expiresAt - TOKEN_EXPIRY_BUFFER_MS;
  }

  getToken(): string {
    // Most call sites are synchronous and cannot await a refresh, so returning an
    // expired token here surfaces as 401 Bad credentials across the whole app.
    // scheduleRefresh() normally keeps the cache warm; this is the safety net.
    if (this.isFresh()) return this.cachedToken;
    return process.env.SYSTEM_GITHUB_TOKEN || "";
  }

  async getTokenAsync(): Promise<string> {
    if (this.isFresh()) {
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

  /**
   * Re-fetch shortly before expiry so the synchronous getToken() always has a
   * live token. Without this the cache goes stale after an hour and every sync
   * caller starts getting 401s until the process restarts.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delay = Math.max(60_000, this.expiresAt - Date.now() - TOKEN_EXPIRY_BUFFER_MS);
    this.refreshTimer = setTimeout(() => {
      this.getTokenAsync().catch((err) =>
        console.error("[TokenManager] Background refresh failed:", (err as Error).message)
      );
    }, delay);
    this.refreshTimer.unref?.(); // never hold the process open
  }

  private async _refresh(): Promise<string> {
    const result = await this.auth({ type: "installation" });
    this.cachedToken = result.token;
    this.expiresAt = new Date(result.expiresAt!).getTime();
    console.log(`[TokenManager] GitHub App token refreshed, expires at ${result.expiresAt}`);
    this.scheduleRefresh();
    return result.token;
  }
}

/**
 * Initialize the GitHub App token manager. Call once at startup.
 *
 * `createAppAuthFn` lets a bundled caller supply the factory from a static
 * import; omitted, the manager resolves it from disk itself.
 *
 * The manager is published only once it works. Assigning it first left a
 * half-built object behind on failure — `auth` undefined — and every later
 * getTokenAsync() threw "this.auth is not a function" rather than falling back
 * to SYSTEM_GITHUB_TOKEN, turning a missing App into a total outage.
 */
export async function initTokenManager(
  appId: string,
  privateKey: string,
  installationId: string,
  createAppAuthFn?: CreateAppAuth,
): Promise<void> {
  const manager = new GitHubTokenManager();
  await manager.init(appId, privateKey, installationId, createAppAuthFn);
  tokenManager = manager;
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



