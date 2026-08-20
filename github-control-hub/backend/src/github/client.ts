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

/** How long to wait before trying again once a background refresh has failed. */
const REFRESH_RETRY_MS = 60_000;

/**
 * How many refresh timers are armed across every manager this process has made.
 *
 * There should never be more than one. It is counted because the failure it
 * guards against is invisible: an orphaned manager keeps working perfectly,
 * against the wrong organization, and nothing on screen says so.
 */
let armedTimers = 0;

/** Test seam. The count is the assertion; there is no other way to see it. */
export function __armedRefreshTimers(): number {
  return armedTimers;
}

/**
 * When the next background refresh should run.
 *
 * Normally: shortly before the token expires, never sooner than a minute. After
 * a failure: soon, and again after that — the alternative is the app deciding,
 * on one bad network moment, that it will never hold a live token again.
 */
export function refreshDelayMs(expiresAt: number, now: number, afterFailure: boolean): number {
  if (afterFailure) return REFRESH_RETRY_MS;
  return Math.max(60_000, expiresAt - now - TOKEN_EXPIRY_BUFFER_MS);
}

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
    if (this.isFresh()) return this.cachedToken;

    // Stale is not the same as expired, and this used to hand back a personal
    // access token instead — a second, broader credential kept permanently for
    // a case that should be rare.
    //
    // isFresh() goes false for the last five minutes of a token's hour, and a
    // token inside that window still works. Returning it is better than
    // returning anything else: scheduleRefresh() is already fetching the
    // replacement, and this call succeeds meanwhile.
    //
    // Past real expiry it returns the expired token, GitHub answers 401, and
    // that is the honest outcome — the App is the only credential, so a
    // broken App should look broken rather than quietly running on a fallback
    // nobody remembers configuring.
    //
    // But honest is not the same as stuck. Nothing here can await, so the
    // refresh is started and this call still returns what it has: the next
    // caller gets a live token seconds later instead of the app needing a
    // restart. getTokenAsync() de-duplicates concurrent refreshes, so a page
    // issuing twenty of these produces one token request.
    if (Date.now() >= this.expiresAt) {
      this.getTokenAsync().catch((err) =>
        console.error("[TokenManager] Refresh after expiry failed:", (err as Error).message)
      );
    }
    return this.cachedToken;
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
  /** Disarm whatever is pending, keeping the count honest. */
  private clearTimer(): void {
    if (!this.refreshTimer) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    armedTimers--;
  }

  /**
   * Stop refreshing, for good.
   *
   * Called when this manager is replaced — every AWS account switch does that,
   * either re-initialising for the account moved into or dropping the manager
   * for one that holds no GitHub App. Reassigning the module-level reference is
   * not enough on its own: an armed timer holds a reference to the object that
   * armed it, so the old manager was never collected and went on minting
   * installation tokens for the organization behind the account just left. One
   * orphan per switch, none of them visible anywhere.
   */
  dispose(): void {
    this.clearTimer();
    this.cachedToken = "";
    this.expiresAt = 0;
  }

  private scheduleRefresh(afterFailure = false): void {
    this.clearTimer();
    const delay = refreshDelayMs(this.expiresAt, Date.now(), afterFailure);
    armedTimers++;
    this.refreshTimer = setTimeout(() => {
      armedTimers--;
      this.refreshTimer = null;
      this.getTokenAsync().catch((err) => {
        console.error("[TokenManager] Background refresh failed:", (err as Error).message);
        // Re-armed, because this used to be where the app gave up.
        //
        // scheduleRefresh() ran only from _refresh()'s success path, so one
        // failed background refresh left no timer at all: the cached token
        // expired, every synchronous caller kept handing GitHub a dead token,
        // and the only cure was restarting the app. A laptop waking with the
        // network not yet up is exactly one failed refresh.
        this.scheduleRefresh(true);
      });
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
 * half-built object behind on failure — `auth` undefined — so every later
 * getTokenAsync() threw "this.auth is not a function" instead of the clear
 * error the caller could act on.
 */
export async function initTokenManager(
  appId: string,
  privateKey: string,
  installationId: string,
  createAppAuthFn?: CreateAppAuth,
): Promise<void> {
  const manager = new GitHubTokenManager();
  await manager.init(appId, privateKey, installationId, createAppAuthFn);
  // Only once the new one works: a failed init must not leave the account we
  // are still in without a token manager.
  tokenManager?.dispose();
  tokenManager = manager;
}

/**
 * Drop the token manager and stop it refreshing.
 *
 * Used when the AWS account being switched into holds no GitHub App: its
 * credentials were minted from the previous account's key, and every call made
 * with them would be attributed to an organization this account is not supposed
 * to touch.
 */
export function disposeTokenManager(): void {
  tokenManager?.dispose();
  tokenManager = null;
}

/**
 * The GitHub App's installation token. The only credential this app has.
 *
 * There used to be a fallback to a `SYSTEM_GITHUB_TOKEN` personal access token,
 * held permanently against the chance that the App failed. It has been removed:
 * a classic PAT with `admin:org` is broader than the App it was backing up,
 * belongs to one person, usually never expires, and — because it worked — meant
 * a broken App could go unnoticed for weeks.
 *
 * Empty means the App is not configured or not working, which is a thing to fix
 * rather than paper over.
 */
export function getSystemToken(): string {
  return tokenManager?.getToken() ?? "";
}

/**
 * Drops the token manager, so `getSystemToken()` reads empty again.
 *
 * Exists for the tests that cover what the app does with no App credentials —
 * a state that is otherwise only reachable by breaking the real ones.
 */
export function __resetTokenManagerForTests(): void {
  disposeTokenManager();
}

/** Async getter — refreshes the App token if it has expired. */
export async function getSystemTokenAsync(): Promise<string> {
  if (!tokenManager) {
    throw new Error(
      "The GitHub App token manager is not initialized. Check that GITHUB_APP_ID, " +
      "GITHUB_APP_PRIVATE_KEY and GITHUB_APP_INSTALLATION_ID are present in Secrets Manager."
    );
  }
  return tokenManager.getTokenAsync();
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



