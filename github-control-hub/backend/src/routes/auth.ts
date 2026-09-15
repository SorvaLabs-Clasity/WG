import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import fsSync from "node:fs";
import { buildAuthorizationUrl, exchangeCodeForToken } from "../github/oauth";
import { createOctokit, getOrg, initTokenManager } from "../github/client";
import { signToken, verifyToken, captureSession, reissueSession, CarriedSession } from "../utils/jwt";
import { storeToken, getToken, removeToken } from "../utils/tokenStore";
import { docClient, tableName, usesDynamo, PutCommand, DeleteCommand } from "../utils/dynamo";
import { authMiddleware } from "../middleware/authMiddleware";
import { awsRegion } from "../utils/region";
import { githubGate } from "../middleware/githubGate";

const router = Router();

// AWS profile names: alphanumeric, hyphens, underscores, dots, max 64 chars
function isValidAwsProfile(name: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(name);
}

const AUTH_CODE_TTL_SEC = 300;

interface AuthCodeEntry {
  token: string;
  login: string;
  avatarUrl: string;
  expiry?: number;
}

const memoryAuthCodes = new Map<string, AuthCodeEntry>();

async function storeAuthCode(code: string, entry: AuthCodeEntry): Promise<void> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    await docClient.send(
      new PutCommand({
        TableName: table,
        Item: {
          code,
          token: entry.token,
          login: entry.login,
          avatarUrl: entry.avatarUrl,
          ttl: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SEC,
        },
      })
    );
  } else {
    memoryAuthCodes.set(code, {
      ...entry,
      expiry: Date.now() + AUTH_CODE_TTL_SEC * 1000,
    });
  }
}

/**
 * Redeem a one-time code, once.
 *
 * The delete does the reading. A Get followed by a Delete is two operations,
 * and a code presented twice in the gap between them was returned twice,
 * each time carrying a signed session for the account that logged in. Delete
 * with ALL_OLD is a single conditional write: whichever caller's delete
 * actually removed the row is handed the item, and every other caller gets
 * nothing back.
 *
 * The expiry is then checked here rather than left to DynamoDB. A `ttl`
 * attribute is a request, not a guarantee, AWS sweeps expired items within
 * about 48 hours, so a code long past its five minutes is still sitting in the
 * table and still redeemable. The in-memory path always checked; the Dynamo
 * path, which is the one that runs in production, did not.
 */
async function consumeAuthCode(code: string): Promise<AuthCodeEntry | null> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    const result = await docClient.send(
      new DeleteCommand({ TableName: table, Key: { code }, ReturnValues: "ALL_OLD" })
    );
    const item = result.Attributes as (AuthCodeEntry & { ttl?: number }) | undefined;
    if (!item?.token) return null;
    if (typeof item.ttl === "number" && item.ttl * 1000 < Date.now()) return null;
    return { token: item.token, login: item.login, avatarUrl: item.avatarUrl };
  }
  const entry = memoryAuthCodes.get(code);
  if (!entry || (entry.expiry && entry.expiry < Date.now())) return null;
  memoryAuthCodes.delete(code);
  return entry;
}

// OAuth state storage for CSRF protection
const OAUTH_STATE_TTL_SEC = 600;
const memoryOAuthStates = new Map<string, number>();

async function storeOAuthState(state: string): Promise<void> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    await docClient.send(
      new PutCommand({
        TableName: table,
        Item: {
          code: `state:${state}`,
          ttl: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SEC,
        },
      })
    );
  } else {
    memoryOAuthStates.set(state, Date.now() + OAUTH_STATE_TTL_SEC * 1000);
  }
}

/** Single-use and time-limited, for the same reasons as consumeAuthCode above. */
async function consumeOAuthState(state: string): Promise<boolean> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    const result = await docClient.send(
      new DeleteCommand({
        TableName: table,
        Key: { code: `state:${state}` },
        ReturnValues: "ALL_OLD",
      })
    );
    const item = result.Attributes as { ttl?: number } | undefined;
    if (!item) return false;
    if (typeof item.ttl === "number" && item.ttl * 1000 < Date.now()) return false;
    return true;
  }
  const expiry = memoryOAuthStates.get(state);
  if (!expiry || expiry < Date.now()) return false;
  memoryOAuthStates.delete(state);
  return true;
}

/**
 * Is this stored session still usable?
 *
 * The signature was the whole of the answer, and it is only half of it. A JWT
 * lasts eight hours; the GitHub token it stands for lives in a Map in this
 * process, and is dropped when the backend restarts, when the user signs out,
 * and when authMiddleware finds they have left the organization. In every one
 * of those cases the signature still verifies, so this said "valid", the
 * login page kept the session, sent the user into the app, and the first API
 * call 401'd them straight back to the login page it had just let them leave.
 *
 * Both halves now. Deliberately no GitHub call: authMiddleware already
 * re-checks org membership on every request with its own cache, and this
 * endpoint is exempt from the auth rate limiter precisely because it is meant
 * to be cheap.
 */
router.get("/verify", (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.json({ valid: false });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    if (!getToken(payload.githubId)) {
      res.json({ valid: false, reason: "session_expired" });
      return;
    }
    res.json({ valid: true, login: payload.login, avatarUrl: payload.avatarUrl });
  } catch {
    res.json({ valid: false });
  }
});

/**
 * What the signed-in user is allowed to do beyond ordinary repo work.
 *
 * Per-repo permissions deliberately are NOT reported here: those calls run with
 * the user's own token and GitHub decides, so there is nothing to mirror. This
 * only covers org-wide Control Hub settings, which have no GitHub equivalent.
 */
router.get("/permissions", authMiddleware, async (req: Request, res: Response) => {
  const { controlHubAdminVia, awsAdminVia, CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } =
    await import("../services/authorizationService");
  try {
    /**
     * The route, not only the verdict.
     *
     * An organization owner passes both of these whatever team they are on,
     * deliberately — otherwise a deleted team locks everyone out of their own
     * settings. Reported as a yes and nothing else, that rule is invisible:
     * somebody takes themselves out of both teams to check the gate works,
     * nothing changes, and the only available conclusion is that the
     * permissions are broken. They are not, and the app can simply say so.
     */
    const [github, aws] = await Promise.all([
      controlHubAdminVia(req.user!.login, req.user!.accessToken),
      awsAdminVia(req.user!.login, req.user!.accessToken),
    ]);
    res.json({
      login: req.user!.login,
      isControlHubAdmin: !!github,
      controlHubAdminVia: github,
      adminTeam: CONTROL_HUB_ADMIN_TEAM,
      isAwsAdmin: !!aws,
      awsAdminVia: aws,
      awsAdminTeam: AWS_ADMIN_TEAM,
    });
  } catch (err: any) {
    console.error("[auth/permissions]", err?.message ?? err);
    res.json({
      login: req.user!.login,
      isControlHubAdmin: false, controlHubAdminVia: null, adminTeam: CONTROL_HUB_ADMIN_TEAM,
      isAwsAdmin: false, awsAdminVia: null, awsAdminTeam: AWS_ADMIN_TEAM,
    });
  }
});

router.get("/status", async (_req: Request, res: Response) => {
  const { isAwsLocked } = await import("../middleware/awsHealthMiddleware");
  const awsConnected = !!process.env.ACTIVITY_TABLE;
  const githubConfigured = !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET;

  /**
   * Why GitHub is not configured, when it is not.
   *
   * "OAuth is not configured on this build" is the right sentence for a build
   * that genuinely shipped without credentials, and the wrong one for an
   * install whose secret has never been created, which is every install until
   * someone runs the migration script. It sends people to look at their
   * packaging instead of at the step they have not done yet.
   *
   * Only asked when AWS is up and GitHub is not, so a working app never makes
   * this call.
   */
  let githubReason: string | undefined;
  if (awsConnected && !githubConfigured && !isAwsLocked()) {
    const secretName = process.env.SECRET_NAME
      || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
    try {
      const { SecretsManagerClient, DescribeSecretCommand } =
        await import("@aws-sdk/client-secrets-manager");
      const { awsRegion } = await import("../utils/region");
      await new SecretsManagerClient({ region: awsRegion() })
        .send(new DescribeSecretCommand({ SecretId: secretName }));
      githubReason = "secret_incomplete";
    } catch (err: any) {
      githubReason = err?.name === "ResourceNotFoundException"
        ? "secret_missing"
        : "secret_unreadable";
    }
  }
  const org = process.env.GITHUB_ORG || null;

  let dynamoReachable = false;

  if (awsConnected && !isAwsLocked()) {
    try {
      const { docClient, tableName } = await import("../utils/dynamo");
      const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
      await docClient.send(new ScanCommand({ TableName: tableName("ACTIVITY_TABLE"), Limit: 1 }));
      dynamoReachable = true;
    } catch {}
  }

  res.json({
    aws: {
      connected: awsConnected,
      dynamoReachable,
      region: awsRegion(),

      profile: process.env.AWS_PROFILE || "default",
    },
    // Whether the GitHub half of the app may be used against the account this

    // app is signed into. Distinct from `github.configured`, which is about

    // whether credentials exist at all.

    githubAccess: await githubGate(),
    github: { configured: githubConfigured, org, reason: githubReason },
  });
});

// Desktop-only endpoints, blocked on EC2/server deployments
const serverModeGuard = (_req: Request, res: Response, next: Function) => {
  if (process.env.__SERVER_MODE__) {
    res.status(403).json({ error: "This endpoint is not available on server deployments" });
    return;
  }
  next();
};

/**
 * Refuse state-changing requests that some other site caused the browser to make.
 *
 * These routes are reachable without a session by design, since reconnecting
 * AWS is how you get a session back, so the usual token check is unavailable
 * and any page the user has open could POST to `/auth/invalidate-aws`. CORS
 * governs reading the response, not sending the request, so it does not help.
 *
 * Two signals. `Sec-Fetch-Site` cannot be set by page script, so `cross-site`
 * is a definite no; it is deliberately the weaker check, because ports are not
 * part of a "site" and demanding `same-origin` would refuse every request in
 * development while adding nothing against a cross-origin attacker.
 *
 * `Origin` does the precise work, since it carries the port. A request with
 * neither header did not come from a browser, and on a loopback listener that
 * means a local process, already inside anything this can protect.
 */
const sameOriginOnly = (req: Request, res: Response, next: NextFunction) => {
  const refuse = () =>
    res.status(403).json({ error: "Cross-site requests are not accepted here" });

  if (req.headers["sec-fetch-site"] === "cross-site") {
    refuse();
    return;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin !== "null") {
    const allowed = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    const permitted = new Set([allowed, allowed.replace("//localhost", "//127.0.0.1")]);
    if (!permitted.has(origin.replace(/\/$/, ""))) {
      refuse();
      return;
    }
  }

  next();
};

// There is deliberately no route here that hands out the system token.
//
// A GET /auth/system-token guarded only by serverModeGuard returns the GitHub
// App installation token, org-wide admin over every repository, to anyone who
// asks. The desktop backend listens on a TCP port, so that includes every other
// process on the machine.
//
// Its one caller is the auto-updater in the Electron main process, which runs
// this backend in-process and reads the token by calling getSystemToken()
// directly. A function call inside one process cannot be reached from off it,
// which no amount of guarding an HTTP route achieves.

/**
 * The endpoints that establish or repair a connection, which therefore cannot
 * require one.
 *
 * This used to fall through to `authMiddleware` once the app was configured
 * and AWS was healthy, and that combination is the ordinary way to reach the
 * login screen: the app sat open, the session token expired, and the screen
 * whose whole job is getting a session could not list AWS profiles without
 * one. "Missing or invalid Authorization header", on the login screen, with no
 * way forward but reinstalling or pasting access keys.
 *
 * Two earlier exceptions were carved for the same knot seen from other angles,
 * nothing configured yet, and AWS unusable. Both were about AWS. The general
 * rule they were reaching for is simply that a connection endpoint cannot
 * demand the session that connecting produces, and `sameOriginOnly` on these
 * same routes already says so in its own comment: "reachable without a session
 * by design, since reconnecting AWS is how you get a session back".
 *
 * What keeps them safe is where they can run, not who is calling:
 *
 *   - `serverModeGuard` refuses them outright on a server deployment, so the
 *     only caller is the desktop app on somebody's own machine.
 *   - `sameOriginOnly` refuses anything another site caused the browser to
 *     send.
 *
 * What they expose there is the ~/.aws/config of the machine the app is
 * installed on, which any local process able to reach this port can already
 * read directly.
 *
 * Kept as a named middleware rather than deleted, so the routes keep saying
 * what they are, and so this reasoning sits where somebody would otherwise
 * "restore" the session check and lock the login screen again.
 */
const setupOrAuthMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
  next();
};

/**
 * Which AWS account's secrets are currently in the environment.
 *
 * Empty until something loads them. Compared against the account in use, so a
 * switch reloads rather than keeping what the last one had.
 */
let secretsLoadedFor = "";

/** The GitHub keys this app reads out of Secrets Manager. */
const SECRET_KEYS = [
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET",
  "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID",
] as const;

/**
 * Everything that has to happen once the AWS credentials have changed.
 *
 * Three endpoints switch accounts, a profile, an SSO profile, and pasted
 * access keys, and each of them has to load the new account's secrets, make
 * the GitHub gate look at the account again, and hand back a session the new
 * account can verify. Doing that in three places is how two of them end up
 * doing two of the three.
 *
 * `carried` must have been captured *before* the credentials moved: it is
 * verified against the signing key of the account being left, and that key is
 * gone by the time this runs.
 */
async function completeAwsSwitch(
  carried: CarriedSession | null,
): Promise<{ secretsLoaded: boolean; token?: string }> {
  const secretsLoaded = await reloadSecretsIfNeeded();

  // Everything cached because it "could not change mid-process", the gate's
  // account id, the guardrail store's own DynamoDB client, the home account id
  // stamped on every finding. All of those were true of an app that chose an
  // account at launch and kept it.
  const { forgetAccountScopedCaches } = await import("../utils/awsAccountChange");
  await forgetAccountScopedCaches();

  // Re-signed with whatever key is loaded now, keeping the original expiry.
  // Without this the session is checked against the wrong key on the very next
  // request and reported as invalid, which is a logout, in the middle of an
  // action the user thinks of as changing one setting.
  const token = carried ? reissueSession(carried) ?? undefined : undefined;
  return { secretsLoaded, ...(token ? { token } : {}) };
}

/**
 * Load GitHub secrets for the account now in use.
 *
 * Keyed on the account. Returning early once any secrets are loaded keeps the
 * first account's credentials for the life of the process, so switching AWS
 * accounts leaves the previous one's OAuth app, organization and App private
 * key in the environment, and an account holding no GitHub credentials behaves
 * as though it held another's.
 *
 * Same account, nothing to do. Different account, read again and **clear**
 * every key the new secret does not set: a stale value is worse than a missing
 * one, because missing says so and stale silently belongs somewhere else.
 */
async function reloadSecretsIfNeeded(): Promise<boolean> {
  let account = "";
  try {
    const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
    const sts = new STSClient({ region: awsRegion() });
    account = (await sts.send(new GetCallerIdentityCommand({}))).Account ?? "";
  } catch {
    // No usable credentials: nothing to load from, and nothing to invalidate.
    return false;
  }

  if (account && account === secretsLoadedFor) return false;

  /**
   * Counts belong to the account they were spent in.
   *
   * The GitHub request counters buffer in memory and flush on a timer, and the
   * table they flush to follows whichever account is connected. So a switch
   * with a full buffer writes one account's usage into another's table, which
   * is how the numbers on a fresh AWS-only account came to look like somebody
   * else's.
   *
   * Discarded rather than flushed: the credentials for the account those
   * requests belong to are already gone by the time this runs, so there is
   * nowhere correct left to put them. Losing a partial minute is the honest
   * outcome; writing it to the wrong account is not.
   */
  try {
    const usage = await import("../services/githubUsageService");
    const dropped = usage.pendingUsage().reduce((a2, r) => a2 + r.count, 0);
    usage.__resetUsageBuffer();
    if (dropped > 0) {
      console.log(`[auth] Discarded ${dropped} unflushed GitHub request counts `
        + `belonging to account ${secretsLoadedFor || "unknown"}`);
    }
  } catch { /* counting must never block a switch */ }

  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const region = awsRegion();
    const secretName = process.env.SECRET_NAME || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
    const client = new SecretsManagerClient({ region });
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      for (const key of SECRET_KEYS) {
        // Set or cleared, never left. An account with no GitHub App must not
        // inherit the last account's.
        if (secrets[key]) process.env[key] = secrets[key];
        else delete process.env[key];
      }
      secretsLoadedFor = account;
      if (!process.env.JWT_SECRET) {
        const crypto = await import("crypto");
        process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
      }
      // Initialize GitHub App token manager if credentials were loaded
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        await initTokenManager(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY, process.env.GITHUB_APP_INSTALLATION_ID);
        console.log(`[auth] GitHub App token manager initialized for account ${account}`);
      } else {
        // Dropped, and actually stopped. It holds a token minted from the
        // previous account's App key, and every call made with it would be
        // attributed to an organization this account is not supposed to touch.
        //
        // This used to null the reference and leave the refresh timer armed,
        // which kept the old manager alive and refreshing, the reference was
        // gone, so nothing could even see it happening.
        const { disposeTokenManager } = await import("../github/client");
        disposeTokenManager();
        const { resetGithubGate } = await import("../middleware/githubGate");
        resetGithubGate();
        console.log(`[auth] Account ${account} has no GitHub App, token manager cleared`);
      }
      return true;
    }
  } catch (err: any) {
    console.warn("[auth] Could not reload secrets:", err.message);
  }
  return false;
}

router.post("/invalidate-aws", serverModeGuard, sameOriginOnly, async (_req: Request, res: Response) => {
  const { lockAws } = await import("../middleware/awsHealthMiddleware");
  const { resetDynamoClient } = await import("../utils/dynamo");

  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;

  // Otherwise the next launch quietly reconnects to the account you just
  // deliberately left.
  const { forgetAwsProfile } = await import("../services/desktopPrefs");
  forgetAwsProfile();

  lockAws();
  resetDynamoClient();
  res.json({ ok: true });
});

router.post("/reconnect-aws", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { unlockAws } = await import("../middleware/awsHealthMiddleware");
  const dynamo = await import("../utils/dynamo");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");

  const profile = req.body?.profile as string | undefined;
  if (profile) {
    if (!isValidAwsProfile(profile)) {
      res.status(400).json({ error: "Invalid AWS profile name" });
      return;
    }
    process.env.AWS_PROFILE = profile;
    // Cleared, because the environment beats the profile.
    //
    // The AWS credential chain reads AWS_ACCESS_KEY_ID before AWS_PROFILE, so
    // keys left from an earlier sign-in keep winning while this route reports
    // the profile it just set. Every screen then names one account while every
    // call goes to another, which is unfalsifiable from inside the app: it
    // looks like a missing resource rather than a wrong account.
    //
    // Only when a profile was named. Without one this is "try again with what
    // we have", and clearing them would sign out anybody using pasted keys.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    // The file may have changed since this process parsed it, a profile added
    // by this app, or one the person added in a terminal while it was running.
    const { refreshAwsConfigCache } = await import("../services/ssoSetupService");
    await refreshAwsConfigCache();
  }

  // Read while the key that signed it is still the one loaded.
  const carried = captureSession(req.headers.authorization);

  unlockAws();
  dynamo.resetDynamoClient();

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const switched = await completeAwsSwitch(carried);
    // Remembered only now, having actually reached DynamoDB. Storing it on the
    // way in would mean a typo becomes the profile you are offered every
    // launch from then on.
    const { rememberAwsProfile } = await import("../services/desktopPrefs");
    if (process.env.AWS_PROFILE) rememberAwsProfile(process.env.AWS_PROFILE);
    res.json({ ok: true, reachable: true, ...switched });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

// ── Creating an SSO profile from the app ──────────────────────────────
//
// Three steps, because the middle one is a person going to their browser.
// Everything here carries the same guards as the rest of the AWS endpoints:
// desktop only, same origin only. Writing to ~/.aws/config is not something a
// deployed server should ever be asked to do.

/** Step one: ask AWS to start an authorization and hand back a URL to open. */
router.post("/aws-sso-start", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware,
  async (req: Request, res: Response) => {
    const startUrl = String(req.body?.startUrl ?? "").trim();
    const ssoRegion = String(req.body?.ssoRegion ?? "").trim();

    const { isValidStartUrl, isValidRegion, startDeviceAuthorization } =
      await import("../services/ssoSetupService");

    if (!isValidStartUrl(startUrl)) {
      return res.status(400).json({
        error: "That does not look like an AWS sign-in URL. It usually ends in "
          + ".awsapps.com/start and is on your access portal page.",
      });
    }
    if (!isValidRegion(ssoRegion)) {
      return res.status(400).json({ error: `"${ssoRegion}" is not an AWS region.` });
    }

    try {
      const auth = await startDeviceAuthorization(startUrl, ssoRegion);
      // The secrets in here are throwaway and scoped to this one sign-in, but
      // they are still credentials: returned for the client to hand straight
      // back on the next call, never logged.
      res.json(auth);
    } catch (err: any) {
      res.status(502).json({
        error: `AWS refused to start the sign-in: ${err?.message ?? err}. `
          + `Check the sign-in URL and its region.`,
      });
    }
  });

/** Step two: has it been approved yet, and if so, what can they reach? */
router.post("/aws-sso-poll", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware,
  async (req: Request, res: Response) => {
    const { clientId, clientSecret, deviceCode, ssoRegion } = req.body ?? {};
    const { isValidRegion, pollForToken, listAccountsAndRoles } =
      await import("../services/ssoSetupService");

    if (!clientId || !clientSecret || !deviceCode || !isValidRegion(String(ssoRegion))) {
      return res.status(400).json({ error: "Incomplete sign-in details" });
    }

    try {
      const token = await pollForToken({
        clientId: String(clientId), clientSecret: String(clientSecret),
        deviceCode: String(deviceCode), ssoRegion: String(ssoRegion),
      });
      // Not an error, and the ordinary answer for the first several calls: the
      // person is still reading a page in their browser.
      if (!token) return res.json({ status: "pending" });

      const accounts = await listAccountsAndRoles(token, String(ssoRegion));
      // The access token is deliberately not returned. It would let the caller
      // reach every account this person has, and nothing on this screen needs
      // it, the account and role names are the whole point.
      res.json({ status: "ready", accounts });
    } catch (err: any) {
      res.status(502).json({ status: "failed", error: err?.message ?? String(err) });
    }
  });

/** Step three: write it into ~/.aws/config. */
router.post("/aws-sso-create-profile", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware,
  async (req: Request, res: Response) => {
    const profileName = String(req.body?.profileName ?? "").trim();
    const startUrl = String(req.body?.startUrl ?? "").trim();
    const ssoRegion = String(req.body?.ssoRegion ?? "").trim();
    const accountId = String(req.body?.accountId ?? "").trim();
    const roleName = String(req.body?.roleName ?? "").trim();
    const region = String(req.body?.region ?? "").trim();

    const {
      isValidStartUrl, isValidRegion, isValidAccountId, isValidRoleName,
      renderProfile, alreadyDefined,
    } = await import("../services/ssoSetupService");

    // Every one of these is about to be written into a config file the AWS CLI
    // will parse. A value carrying a newline and a `[` would not corrupt the
    // file. It would quietly define a second profile.
    const problems: string[] = [];
    if (!isValidAwsProfile(profileName)) problems.push("the profile name may use letters, numbers, dots, dashes and underscores");
    if (!isValidStartUrl(startUrl)) problems.push("the sign-in URL is not an AWS one");
    if (!isValidRegion(ssoRegion)) problems.push(`"${ssoRegion}" is not a region`);
    if (!isValidAccountId(accountId)) problems.push("the account id must be twelve digits");
    if (!isValidRoleName(roleName)) problems.push("that is not a valid role name");
    if (!isValidRegion(region)) problems.push(`"${region}" is not a region`);
    if (problems.length) return res.status(400).json({ error: problems.join("; ") });

    try {
      const fs = await import("fs");
      const path = await import("path");
      const {
        configFilePath, readIniFile, findIniProblems, describeProblems,
        cliCanRead, stripByteOrderMark,
      } = await import("../services/awsConfigFile");

      // The file the CLI reads, which is not always the one under the home
      // directory. Writing a correct profile into a file nothing reads is how
      // "the profile was created" and "no such profile" end up both being true.
      const configPath = configFilePath();
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      let file = readIniFile(configPath);

      /**
       * An encoding the CLI cannot read is repaired, not refused.
       *
       * This is the case that produced the report. The file was UTF-8 with a
       * byte-order mark; this app skipped the mark, saw a clean file, appended
       * a correct profile and said so; and `aws sso login --profile <it>`
       * answered "Unable to parse config file" — because those three bytes
       * make configparser refuse the whole thing, and always did, before the
       * profile was ever added.
       *
       * Refusing to append was the previous answer and it was not enough: the
       * file was already unusable, so declining to touch it changed nothing
       * except that now nobody could create a profile either. Re-saving it as
       * plain UTF-8 keeps every character and takes a copy first.
       */
      let repairedFrom: string | undefined;
      let backupPath: string | undefined;
      if (file && !cliCanRead(file.encoding)) {
        repairedFrom = file.encoding;
        backupPath = stripByteOrderMark(configPath)?.backup;
        file = readIniFile(configPath);
      }

      const existing = file?.text ?? "";

      /**
       * Refuse to add to a file the CLI cannot parse for reasons in its text.
       *
       * Unlike the encoding, this cannot be repaired without guessing at what
       * somebody meant. Appending would succeed, the screen would say the
       * profile was created, and the CLI would still refuse the file — which
       * reads as though this app wrote something invalid. What it wrote is
       * fine; what was already there is not, and that is the thing worth
       * saying before touching the file at all.
       */
      if (file) {
        const problems = findIniProblems(existing);
        if (problems.length > 0) {
          return res.status(409).json({
            error: describeProblems(configPath, file.encoding, problems),
            code: "AWS_CONFIG_UNPARSEABLE",
            path: configPath,
          });
        }
      }

      if (alreadyDefined(existing, `profile ${profileName}`)) {
        return res.status(409).json({
          error: `A profile called "${profileName}" already exists. Pick another name, `
            + `or use the existing one from the list above.`,
        });
      }

      // One session per sign-in URL, shared by every profile using it, so
      // signing in once authorizes them all.
      const sessionName = `${profileName}-sso`;
      let block = renderProfile({
        profileName, sessionName, startUrl, ssoRegion, accountId, roleName, region,
      });
      if (alreadyDefined(existing, `sso-session ${sessionName}`)) {
        // Re-declaring a session the file already has would give the CLI two
        // definitions of the same name.
        block = block.slice(block.indexOf(`[profile ${profileName}]`) - 1);
      }

      // Appended, never rewritten. This file is the machine's, not ours: it may
      // hold profiles for work nothing to do with this app, and the only safe
      // edit is one that adds.
      //
      // In the line ending the file already uses. A CRLF file that suddenly has
      // LF in the middle still parses, but it renders as one long line in
      // Notepad, which is where somebody on Windows goes to look at it.
      const eol = file?.eol ?? (process.platform === "win32" ? "\r\n" : "\n");
      const gap = existing && !/\n$/.test(existing) ? eol : "";
      fs.appendFileSync(configPath, gap + block.replace(/\n/g, eol), { mode: 0o600 });

      // The file has changed under a process that already parsed it. Without
      // this the profile is real, correct, and invisible until the next launch.
      const { refreshAwsConfigCache } = await import("../services/ssoSetupService");
      await refreshAwsConfigCache();

      // The repair is reported rather than done quietly. It is somebody's own
      // config file, and "we re-saved it and the old one is over there" is the
      // kind of thing they should hear from the app rather than notice later.
      res.json({
        profile: profileName,
        path: configPath,
        repaired: repairedFrom
          ? { from: repairedFrom, backup: backupPath }
          : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: `Could not write ~/.aws/config: ${err?.message ?? err}` });
    }
  });

/**
 * Every AWS profile this machine has, and why there are none when there are.
 *
 * This used to answer 200 with `{ profiles: [], error }` when the read failed,
 * so the screen said "No SSO profiles on this machine yet" whether the machine
 * had none or the file could not be read. Those are opposite messages: one
 * invites you to create a profile, the other means creating one will not help.
 * A read failure is now a failure, and the file it was reading is named either
 * way so the answer can be checked rather than believed.
 */
router.get("/aws-profiles", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (_req: Request, res: Response) => {
  const {
    configFilePath, credentialsFilePath, readIniFile, parseProfiles,
    findIniProblems, describeProblems, cliCanRead,
  } = await import("../services/awsConfigFile");

  const configPath = configFilePath();
  const credsPath = credentialsFilePath();

  try {
    const config = readIniFile(configPath);
    const profiles = config ? parseProfiles(config.text) : [];
    const seen = new Set(profiles.map(p => p.name));

    const creds = readIniFile(credsPath);
    if (creds) {
      for (const line of creds.text.split("\n")) {
        const match = line.trim().match(/^\[(.+)]$/);
        const name = match?.[1]?.trim();
        if (name && !seen.has(name)) {
          profiles.push({ name, type: "static" });
          seen.add(name);
        }
      }
    }

    /**
     * A file we could read but the CLI cannot.
     *
     * Reported alongside whatever we did manage to parse rather than instead
     * of it: the profiles listed here are real, and the reason they will not
     * work from a terminal is worth saying before somebody spends an afternoon
     * on it.
     */
    const problems = config ? findIniProblems(config.text) : [];
    const unusable = config && (problems.length > 0 || !cliCanRead(config.encoding))
      ? describeProblems(configPath, config.encoding, problems)
      : undefined;

    /**
     * Whether the app can do anything about it, which decides whether the
     * screen offers a button or only an explanation.
     *
     * An encoding is repairable because removing a byte-order mark is not a
     * judgement call — the same characters come back out. A stray line in the
     * text is not: fixing it means deciding what somebody meant, and that
     * belongs to them.
     */
    const fixable = !!config && problems.length === 0 && !cliCanRead(config.encoding);

    res.json({ profiles, configPath, credentialsPath: credsPath, unusable, fixable });
  } catch (err: any) {
    // Reading it threw: a permission problem, or a path that is not a file.
    // Said as a failure, because an empty list here is a different claim.
    res.status(500).json({
      profiles: [],
      configPath,
      error: `Could not read ${configPath}: ${err?.message ?? err}`,
    });
  }
});

/**
 * Re-save `~/.aws/config` as plain UTF-8, on request.
 *
 * The half of the report that the profile writer does not reach. Somebody whose
 * config already has the profile they want never goes near "create a profile",
 * so repairing the encoding on that path alone leaves them with an exact
 * description of their problem, on a screen with no way to act on it, and the
 * terminal fix is the thing this app exists to avoid.
 *
 * Deliberately its own endpoint and its own button rather than something that
 * happens quietly when sign-in is pressed. It is somebody's own config file;
 * they should be the one who says yes.
 */
router.post("/aws-config-repair", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware,
  async (_req: Request, res: Response) => {
    const {
      configFilePath, readIniFile, findIniProblems, describeProblems,
      cliCanRead, stripByteOrderMark,
    } = await import("../services/awsConfigFile");

    const configPath = configFilePath();
    try {
      const file = readIniFile(configPath);
      if (!file) {
        return res.status(404).json({ error: `There is no file at ${configPath}.` });
      }
      if (cliCanRead(file.encoding)) {
        // Nothing to do, and saying so is better than reporting a repair that
        // did not happen. If the file is still unusable it is for a reason in
        // its text, which this cannot fix and should not pretend to.
        const problems = findIniProblems(file.text);
        return res.json({
          repaired: null,
          path: configPath,
          stillUnusable: problems.length
            ? describeProblems(configPath, file.encoding, problems)
            : undefined,
        });
      }

      const result = stripByteOrderMark(configPath);
      const after = readIniFile(configPath);
      const problems = after ? findIniProblems(after.text) : [];

      const { refreshAwsConfigCache } = await import("../services/ssoSetupService");
      await refreshAwsConfigCache();

      res.json({
        repaired: { from: file.encoding, backup: result?.backup },
        path: configPath,
        // A file can have been UTF-16 *and* have a stray line in it. Fixing one
        // and reporting success would send somebody back to the same error.
        stillUnusable: problems.length && after
          ? describeProblems(configPath, after.encoding, problems)
          : undefined,
      });
    } catch (err: any) {
      res.status(500).json({ error: `Could not re-save ${configPath}: ${err?.message ?? err}` });
    }
  });

/**
 * Where the AWS CLI actually is, as something `spawn` can start.
 *
 * On Windows this used to be the literal string `"aws.cmd"`, and both halves of
 * that were wrong.
 *
 * The installer does not ship an `aws.cmd`. AWS CLI v2 installs a real
 * executable, `C:\Program Files\Amazon\AWSCLIV2\aws.exe`, and that is what is
 * on PATH. (v1, installed through pip, did leave an `aws.cmd` shim, which is
 * where the name comes from.)
 *
 * And since the fix for CVE-2024-27980 — Node 18.20.2 and everything after —
 * `spawn` refuses to start a `.cmd` or `.bat` at all without `shell: true`. It
 * does not report this through the `error` event that the code below waits on:
 * it throws *synchronously*, out of the `spawn` call itself, before there is a
 * child to attach a listener to. Inside an async Express 4 handler that becomes
 * an unhandled rejection and the request simply never answers, so the browser's
 * `fetch` hangs forever and the screen keeps showing whatever it said before
 * the call. Which, here, was "a browser tab opened for AWS SSO".
 *
 * So: look for the real executable, by name, in the places it is installed, and
 * fall back to the bare name for PATH resolution when it is nowhere expected.
 * Nothing goes through a shell, so a profile name never reaches a command line.
 */
function resolveAwsCli(): { command: string; extraPathDirs: string[] } {
  if (process.platform !== "win32") {
    return { command: "aws", extraPathDirs: ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"] };
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const dirs = [
    `${programFiles}\\Amazon\\AWSCLIV2`,
    `${programFilesX86}\\Amazon\\AWSCLIV2`,
    // The per-user install, which needs no administrator and is therefore what
    // somebody on a locked-down work machine ends up with.
    `${process.env.LOCALAPPDATA}\\Programs\\Amazon\\AWSCLIV2`,
  ];

  for (const dir of dirs) {
    const exe = `${dir}\\aws.exe`;
    if (fsSync.existsSync(exe)) return { command: exe, extraPathDirs: dirs };
  }
  // Not where we expect it, so let the OS search PATH. `.exe` rather than the
  // bare name: spawn without a shell does not apply PATHEXT.
  return { command: "aws.exe", extraPathDirs: dirs };
}

router.post("/aws-sso-login", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { spawn } = await import("child_process");
  const profile = (req.body?.profile as string) || process.env.AWS_PROFILE || "default";

  if (!isValidAwsProfile(profile)) {
    res.status(400).json({ error: "Invalid AWS profile name" });
    return;
  }

  /**
   * `aws sso login` only means anything for a profile that has SSO in it.
   *
   * Handed anything else — an access-key profile, or the `default` this route
   * falls back to when the caller names nothing — the CLI answers
   *
   *     An error occurred (Configuration): Missing the following required SSO
   *     configuration values: sso_start_url, sso_region. To make sure this
   *     profile is properly configured to use SSO, please run: aws configure sso
   *
   * which is accurate, names no profile, and sends somebody to a wizard that
   * will build them a second profile they did not need. The config is already
   * parsed here for other reasons, so the app can say which profile it was
   * about to use and that this is the wrong kind, before spawning anything.
   *
   * Only when the profile is actually readable: an unreadable config is a
   * different failure with its own message, and turning it into "not an SSO
   * profile" would be a worse answer than letting the CLI speak.
   */
  try {
    const { configFilePath, readIniFile, parseProfiles } = await import("../services/awsConfigFile");
    const file = readIniFile(configFilePath());
    if (file) {
      const known = parseProfiles(file.text);
      const found = known.find(p => p.name === profile);
      if (!found) {
        res.status(400).json({
          error: `There is no profile called "${profile}" in ${configFilePath()}.`,
          code: "AWS_PROFILE_NOT_FOUND",
        });
        return;
      }
      if (found.type !== "sso") {
        res.status(400).json({
          error: `"${profile}" is not an SSO profile — it has no sso_start_url or sso_region, `
            + `so "aws sso login" has nothing to sign in to. Pick an SSO profile, or use the `
            + `Profile tab, which is what a profile like this one is for.`,
          code: "AWS_PROFILE_NOT_SSO",
        });
        return;
      }
    }
  } catch {
    // Unreadable config. Let the CLI answer; it is the authority, and the
    // profile list has its own report for this.
  }

  /**
   * Read the config the way the CLI will, before asking the CLI to read it.
   *
   * Everything this checks, the CLI checks too, and answers with one sentence
   * that names none of it: "Unable to parse config file: <path>". Worse, it
   * answers on stderr of a detached child nobody is listening to, so the
   * observable behaviour is a button that reports success and opens nothing.
   *
   * Checked here so the failure arrives in the app, attached to the button that
   * caused it, saying which file and which line.
   */
  {
    const {
      configFilePath, readIniFile, parseProfiles, findIniProblems, describeProblems, cliCanRead,
    } = await import("../services/awsConfigFile");
    const configPath = configFilePath();

    let file: ReturnType<typeof readIniFile>;
    try {
      file = readIniFile(configPath);
    } catch (err: any) {
      res.status(500).json({
        error: `Could not read ${configPath}: ${err?.message ?? err}`,
        code: "AWS_CONFIG_UNREADABLE",
      });
      return;
    }

    if (!file) {
      res.status(400).json({
        error: `There is no AWS config file at ${configPath}, so there is no profile "${profile}" `
          + `to sign in with. Create one from the "New profile" tab.`,
        code: "AWS_CONFIG_MISSING",
        path: configPath,
      });
      return;
    }

    const problems = findIniProblems(file.text);
    if (problems.length > 0 || !cliCanRead(file.encoding)) {
      res.status(409).json({
        error: describeProblems(configPath, file.encoding, problems),
        code: "AWS_CONFIG_UNPARSEABLE",
        path: configPath,
      });
      return;
    }

    // A profile the file does not define. The CLI's own wording for this is
    // fine, but it is on the stderr nobody sees, and by the time somebody runs
    // the command by hand they are already debugging the wrong thing.
    if (!parseProfiles(file.text).some(p => p.name === profile)) {
      res.status(400).json({
        error: `${configPath} does not define a profile called "${profile}".`,
        code: "AWS_PROFILE_NOT_FOUND",
        path: configPath,
      });
      return;
    }
  }

  // Only now that the profile is known to exist. Set before the checks above,
  // a refused sign-in still left the whole process pointed at a profile that
  // could not be used, and every AWS call after it failed for that reason
  // instead of the one the user was shown.
  process.env.AWS_PROFILE = profile;

  const nodePath = await import("path");
  const { command, extraPathDirs } = resolveAwsCli();
  // GUI-launched apps inherit a minimal PATH, so add the usual CLI install dirs.
  // Join with the platform separator, using ":" on Windows corrupts the last
  // real PATH entry and can leave "aws" unresolvable.
  const env = {
    ...process.env,
    PATH: [process.env.PATH, ...extraPathDirs].filter(Boolean).join(nodePath.delimiter),
  };

  /**
   * Started, and then listened to.
   *
   * `stdio: "ignore"` was the other half of the silent failure: whatever the
   * CLI had to say went to a closed pipe. stderr is kept now, capped, and read
   * only for as long as it takes to find out whether the process survives its
   * own startup.
   *
   * Not detached any more either. A detached child is one this process cannot
   * hear from, and the only reason to want that was to let the sign-in outlive
   * a request — which it does perfectly well as an ordinary child, because the
   * request stops waiting on it after the grace period below.
   *
   * No shell, still. With `shell: true` the argument list is flattened into a
   * command string, so the only thing standing between a profile name and
   * command execution is `isValidAwsProfile`, which is correct today and is the
   * wrong thing to be relying on.
   */
  let child: import("child_process").ChildProcess;
  try {
    child = spawn(command, ["sso", "login", "--profile", profile], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      shell: false,
      env,
    });
  } catch (err: any) {
    // spawn throws synchronously for a bad executable — EINVAL for a .cmd or
    // .bat without a shell, which is what Windows used to get here every time.
    // Caught rather than left to reject the handler: Express 4 does not catch
    // an async throw, so it became a request that never answered at all.
    res.status(500).json({
      error: `Could not start the AWS CLI (${command}): ${err?.message ?? err}`,
      code: "AWS_SSO_LAUNCH_FAILED",
    });
    return;
  }

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString();
  });

  /**
   * Three outcomes, and the one that means success is "still running".
   *
   * `aws sso login` opens a browser and then waits for a person to approve it,
   * so it is *supposed* to be alive when this answers. What it must not be is
   * already dead: a config it cannot parse, a profile with no sso_session, an
   * SSO region that does not resolve — all of those exit within a moment, and
   * all of them used to be reported to the user as "check your browser".
   *
   * So: wait a beat, and treat an early exit as the failure it is.
   */
  const GRACE_MS = 2500;
  const outcome = await new Promise<{ ok: true } | { ok: false; code: number | null; err: any }>(resolve => {
    const timer = setTimeout(() => resolve({ ok: true }), GRACE_MS);
    child.once("error", err => { clearTimeout(timer); resolve({ ok: false, code: null, err }); });
    child.once("exit", code => {
      clearTimeout(timer);
      // Exit 0 inside the grace period is a sign-in that was already valid —
      // the CLI says "Token cached" and stops. That is a success.
      resolve(code === 0 ? { ok: true } : { ok: false, code, err: null });
    });
  });

  if (!outcome.ok) {
    const missing = outcome.err?.code === "ENOENT";
    if (missing) {
      res.status(400).json({
        error: `The AWS CLI is not installed, or not on this app's PATH, so "aws sso login" could not be run. `
          + `Install it, or use the Access key tab instead. That needs no CLI.`,
        code: "AWS_CLI_NOT_FOUND",
      });
      return;
    }
    // The CLI's own words, which are usually the exact thing somebody needs and
    // which this endpoint has been throwing away.
    const said = stderr.trim().split("\n").filter(Boolean).slice(-3).join(" ");
    res.status(500).json({
      error: said
        ? `"aws sso login" stopped straight away: ${said}`
        : `"aws sso login" stopped straight away`
          + (outcome.code === null ? "." : ` (exit code ${outcome.code}).`),
      code: "AWS_SSO_LAUNCH_FAILED",
    });
    return;
  }

  // Running, and waiting on a browser. Let it outlive this request without
  // holding the response open.
  //
  // The stderr listener stays attached deliberately. It caps what it *keeps* at
  // 4KB but it keeps reading, and a pipe nobody reads fills its buffer and then
  // blocks the child mid-write — a sign-in that hangs for no visible reason.
  child.unref();
  res.json({ ok: true, profile, message: `AWS SSO login started for profile "${profile}". Check your browser.` });
});

/** Switch to an existing AWS CLI profile (non-SSO). */
/**
 * The `region` a named profile sets in ~/.aws/config, if it sets one.
 *
 * Read here rather than taken from what the browser sent: this decides which
 * account's data every subsequent request reads, and the caller is not the
 * authority on what is in the operator's config file.
 */
async function regionOfProfile(profile: string): Promise<string | null> {
  try {
    // Through the same reader as everything else: it resolves the same file the
    // CLI does, and decodes a UTF-16 config rather than returning the mojibake
    // that a plain utf8 read produces, in which no section header matches and
    // every profile silently has no region.
    const { configFilePath, readIniFile } = await import("../services/awsConfigFile");
    const file = readIniFile(configFilePath());
    if (!file) return null;
    const text = file.text;

    let inProfile = false;
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) {
        // "[default]" has no prefix; every other profile is "[profile name]".
        inProfile = line === `[profile ${profile}]`
          || (profile === "default" && line === "[default]");
        continue;
      }
      if (!inProfile) continue;
      const [k, ...v] = line.split("=");
      if (k?.trim() === "region") {
        const region = v.join("=").trim();
        const { isValidRegion } = await import("../services/ssoSetupService");
        return isValidRegion(region) ? region : null;
      }
    }
    return null;
  } catch {
    // No config file, or unreadable. The caller then clears the inherited one
    // and lets the SDK answer, which is the same as having read nothing here.
    return null;
  }
}

router.post("/aws-use-profile", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { unlockAws } = await import("../middleware/awsHealthMiddleware");
  const dynamo = await import("../utils/dynamo");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");

  const profile = req.body?.profile as string;
  if (!profile) {
    res.status(400).json({ error: "Profile name required" });
    return;
  }
  if (!isValidAwsProfile(profile)) {
    res.status(400).json({ error: "Invalid AWS profile name" });
    return;
  }

  const carried = captureSession(req.headers.authorization);

  process.env.AWS_PROFILE = profile;
  {
    const { refreshAwsConfigCache } = await import("../services/ssoSetupService");
    await refreshAwsConfigCache();
  }
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;

  /**
   * The region comes with the profile, and must not be inherited.
   *
   * `AWS_REGION` beats a profile's own `region` everywhere in the SDK, and the
   * access-keys route sets it. So signing in with keys for one region and then
   * switching to a profile in another left every client talking to the first:
   * the switch reported success, the account id was right, and the tables were
   * empty because they are in the region nobody was reading. Nothing failed.
   *
   * With one installation per region, that stops being an edge case and
   * becomes the ordinary way somebody moves between them.
   *
   * Cleared when the profile names no region, rather than left pointing at the
   * account just departed: the SDK's own resolution is the only thing that can
   * answer this correctly, and a missing region is an error worth seeing.
   */
  const profileRegion = await regionOfProfile(profile);
  if (profileRegion) process.env.AWS_REGION = profileRegion;
  else (await import("../utils/region")).resetRegionToBoot();

  unlockAws();
  dynamo.resetDynamoClient();

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const switched = await completeAwsSwitch(carried);
    const { rememberAwsProfile } = await import("../services/desktopPrefs");
    rememberAwsProfile(profile);
    res.json({ ok: true, reachable: true, ...switched });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

/** Authenticate with explicit access keys. */
router.post("/aws-access-keys", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { unlockAws } = await import("../middleware/awsHealthMiddleware");
  const dynamo = await import("../utils/dynamo");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");

  const { accessKeyId, secretAccessKey, sessionToken } = req.body || {};
  const region = String(req.body?.region ?? "").trim();
  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: "accessKeyId and secretAccessKey are required" });
    return;
  }

  /**
   * A key pair carries no region, so one has to come from somewhere.
   *
   * This used to accept a blank region and fall back to `BOOT_REGION`, which is
   * undefined on every desktop launch — the normal case. The SDK then had no
   * region at all and the first call failed with "Region is missing", a message
   * about the SDK rather than about the form the person had just filled in. It
   * was worse from the paste-block form, which had no region field at all: the
   * AWS access portal's blocks do not carry one, so that path could not succeed
   * on a desktop machine however correct the keys were.
   *
   * Required unless this process was launched with one, which is a choice the
   * operator made for this machine and is the same answer they would have got
   * without switching anything.
   */
  const { BOOT_REGION } = await import("../utils/region");
  if (!region && !BOOT_REGION) {
    res.status(400).json({
      error: "A region is required. Access keys do not carry one, and this app was not "
        + "started with a default, so there is nothing to fall back to. Enter the region "
        + "the install you want to open lives in, such as us-east-1.",
      code: "AWS_REGION_REQUIRED",
    });
    return;
  }
  if (region) {
    const { isValidRegion } = await import("../services/ssoSetupService");
    if (!isValidRegion(region)) {
      res.status(400).json({
        error: `"${region}" is not an AWS region. They look like us-east-1 or eu-west-2.`,
        code: "AWS_REGION_INVALID",
      });
      return;
    }
  }

  const carried = captureSession(req.headers.authorization);

  process.env.AWS_ACCESS_KEY_ID = accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
  if (sessionToken) process.env.AWS_SESSION_TOKEN = sessionToken;
  else delete process.env.AWS_SESSION_TOKEN;
  /**
   * The same rule as the profile route, and it matters more here: keys carry no
   * region, so this optional field is the only thing that can name one.
   *
   * Left blank and inherited, connecting to a second account with keys reads
   * the first account's tables under the second's credentials. Nothing fails;
   * the dashboard is empty.
   */
  if (region) process.env.AWS_REGION = region;
  else (await import("../utils/region")).resetRegionToBoot();
  delete process.env.AWS_PROFILE;

  unlockAws();
  dynamo.resetDynamoClient({
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  });

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const switched = await completeAwsSwitch(carried);
    res.json({ ok: true, reachable: true, ...switched });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

/** Revoke the user's GitHub OAuth grant so next sign-in requires re-authorization. */
router.post("/revoke-github", async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  try {
    const payload = verifyToken(authHeader.slice(7));
    const accessToken = getToken(payload.githubId);
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (clientId && clientSecret && accessToken) {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      await fetch(`https://api.github.com/applications/${clientId}/grant`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: accessToken }),
      });
    }

    // Remove the token from the server-side store
    removeToken(payload.githubId);

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[auth/revoke-github] error:", err.message);
    res.json({ ok: true });
  }
});

router.get("/debug", authMiddleware, (_req: Request, res: Response) => {
  res.json({
    hasClientId: !!process.env.GITHUB_CLIENT_ID,
    hasClientSecret: !!process.env.GITHUB_CLIENT_SECRET,
    hasJwtSecret: !!process.env.JWT_SECRET,
    hasFrontendUrl: !!process.env.FRONTEND_URL,
    hasBackendUrl: !!process.env.BACKEND_URL,
    hasGitHubOrg: !!process.env.GITHUB_ORG,
    githubOrg: process.env.GITHUB_ORG || "(not set)",
  });
});

/**
 * Start of the OAuth flow.
 *
 * Wrapped, because this had no error handling and the sign-in button is a plain
 * link. `buildAuthorizationUrl` throws when GITHUB_CLIENT_ID is unset, and an
 * async route that throws in Express never answers, so the browser sat on a
 * request that would never complete. On screen that is *nothing at all*: no
 * error, no spinner, no navigation. The most common cause is the most invisible
 * one, which is an account whose secret has no OAuth credentials in it.
 */
router.get("/github", async (req: Request, res: Response) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    await storeOAuthState(state);
    // The login page passes the account it offered to continue with, so GitHub
    // signs in as that one rather than whichever session it happens to hold.
    const login = typeof req.query.login === "string" ? req.query.login : undefined;
    res.redirect(buildAuthorizationUrl(state, login));
  } catch (err: any) {
    const missingClientId = !process.env.GITHUB_CLIENT_ID;
    console.error("[auth] Could not start GitHub sign-in:", err?.message ?? err);
    res.status(500).type("html").send(`
      <h2>Could not start GitHub sign-in</h2>
      <p>${missingClientId
        ? "This AWS account's secret has no GitHub OAuth credentials in it, so there is "
          + "nothing to sign in with. If this account is meant to run the AWS guardrails "
          + "only, that is expected. Use the AWS tab."
        : String(err?.message ?? err)}</p>
      <p><a href="/login">Back</a></p>
    `);
  }
});

router.get("/token", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code.trim() : null;
  if (!code) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }
  try {
    const entry = await consumeAuthCode(code);
    if (!entry) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ token: entry.token, login: entry.login, avatarUrl: entry.avatarUrl });
  } catch (err) {
    console.error("[auth/token] error:", err);
    res.setHeader("Cache-Control", "no-store");
    res.status(500).json({ error: "Failed to exchange code" });
  }
});

router.get("/callback", async (req: Request, res: Response) => {
  const { code, state } = req.query;

  // Validate OAuth state parameter for CSRF protection
  if (typeof state !== "string" || !(await consumeOAuthState(state))) {
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    const params = new URLSearchParams({ auth_error: "invalid_state" });
    res.redirect(`${frontendUrl}/login?${params}`);
    return;
  }

  if (typeof code !== "string") {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }

  try {
    const accessToken = await exchangeCodeForToken(code);
    const octokit = createOctokit(accessToken, "Signing in");

    const { data: user } = await octokit.rest.users.getAuthenticated();

    const org = getOrg();
    try {
      await octokit.rest.orgs.checkMembershipForUser({
        org,
        username: user.login,
      });
    } catch {
      const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
      const params = new URLSearchParams({
        auth_error: "not_member",
        login: user.login,
        org,
      });
      res.redirect(`${frontendUrl}/login?${params}`);
      return;
    }

    // Store GitHub access token server-side (never in the JWT)
    storeToken(user.id, accessToken);

    const token = signToken({
      githubId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
    });

    const oneTimeCode = crypto.randomBytes(24).toString("hex");
    await storeAuthCode(oneTimeCode, {
      token,
      login: user.login,
      avatarUrl: user.avatar_url,
    });
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    res.redirect(`${frontendUrl}/login?code=${oneTimeCode}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    console.error("OAuth callback error:", err);
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    const params = new URLSearchParams({ auth_error: "failed", detail: message });
    res.redirect(`${frontendUrl}/login?${params}`);
  }
});

export default router;
