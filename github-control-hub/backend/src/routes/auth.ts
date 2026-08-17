import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { buildAuthorizationUrl, exchangeCodeForToken } from "../github/oauth";
import { createOctokit, getOrg, initTokenManager } from "../github/client";
import { signToken, verifyToken } from "../utils/jwt";
import { storeToken, getToken, removeToken } from "../utils/tokenStore";
import { docClient, tableName, usesDynamo, PutCommand, DeleteCommand } from "../utils/dynamo";
import { authMiddleware } from "../middleware/authMiddleware";
import { awsRegion } from "../utils/region";

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
 * and a code presented twice in the gap between them was returned twice —
 * each time carrying a signed session for the account that logged in. Delete
 * with ALL_OLD is a single conditional write: whichever caller's delete
 * actually removed the row is handed the item, and every other caller gets
 * nothing back.
 *
 * The expiry is then checked here rather than left to DynamoDB. A `ttl`
 * attribute is a request, not a guarantee — AWS sweeps expired items within
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

router.get("/verify", (req: Request, res: Response) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.json({ valid: false });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
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
  const { isControlHubAdmin, isAwsAdmin, CONTROL_HUB_ADMIN_TEAM, AWS_ADMIN_TEAM } =
    await import("../services/authorizationService");
  try {
    const [github, aws] = await Promise.all([
      isControlHubAdmin(req.user!.login),
      isAwsAdmin(req.user!.login),
    ]);
    res.json({
      login: req.user!.login,
      isControlHubAdmin: github,
      adminTeam: CONTROL_HUB_ADMIN_TEAM,
      isAwsAdmin: aws,
      awsAdminTeam: AWS_ADMIN_TEAM,
    });
  } catch (err: any) {
    console.error("[auth/permissions]", err?.message ?? err);
    res.json({
      login: req.user!.login,
      isControlHubAdmin: false, adminTeam: CONTROL_HUB_ADMIN_TEAM,
      isAwsAdmin: false, awsAdminTeam: AWS_ADMIN_TEAM,
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
   * install whose secret has never been created — which is every install until
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
    github: { configured: githubConfigured, org, reason: githubReason },
  });
});

// Desktop-only endpoints — blocked on EC2/server deployments
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
 * These routes are reachable without a session by design — reconnecting AWS is
 * how you get a session back — so the usual token check is not available. That
 * left CSRF: any page the user happened to have open could POST to
 * http://localhost:4321/auth/invalidate-aws and disconnect their account. CORS
 * does not help, because it governs reading the response, not sending the
 * request; a simple POST is delivered and acted on whatever CORS says
 * afterwards.
 *
 * Two signals. `Sec-Fetch-Site` is attached by current browsers and cannot be
 * set by page script, so `cross-site` is a definite no. It is deliberately the
 * weaker of the two checks: ports are not part of a "site", so the dev server
 * on :5173 calling the backend on :4000 reports `same-site`, and rejecting
 * anything short of `same-origin` would refuse every request in development
 * while adding nothing against a cross-origin attacker.
 *
 * `Origin` does the precise work — it carries the port, and is compared against
 * the URL this app actually serves. A request carrying neither header did not
 * come from a browser; after the listener moved to loopback that means a
 * process on this machine, which is already inside anything this can protect.
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
// There used to be: GET /auth/system-token, guarded only by serverModeGuard,
// returning the GitHub App installation token — org-wide admin over every
// repository — to anyone who asked. The desktop backend listens on a TCP port,
// so "anyone who asked" included every other process on the machine and, until
// the listener was moved to loopback, every device on the same network.
//
// Its one caller was the auto-updater in the Electron main process, which runs
// this backend in-process (desktop/src/server.ts require()s it). It reads the
// token by calling getSystemToken() directly. A function call inside one
// process cannot be reached from off it, which no amount of guarding an HTTP
// route achieves.

// During initial setup (no GitHub OAuth secrets loaded yet), allow AWS credential
// endpoints without authentication. Once secrets are loaded, require auth.
// This breaks the chicken-and-egg: AWS must be connected before GitHub OAuth
// secrets can be loaded from Secrets Manager.
const setupOrAuthMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  // Never yet configured: the original chicken-and-egg, since the GitHub OAuth
  // secrets these endpoints would authenticate against live in Secrets Manager,
  // which needs AWS.
  if (!process.env.GITHUB_CLIENT_ID) {
    next();
    return;
  }

  // The same knot, retied. Once secrets had loaded, this demanded a GitHub
  // session — but disconnecting AWS (or "Reset both connections", which also
  // drops the session) left no way to list AWS profiles and so no way to
  // reconnect except by pasting access keys. Whenever AWS is not usable, these
  // endpoints are the only route back and must stay open.
  //
  // Safe because of where they can run: serverModeGuard blocks all of them on
  // EC2, so the only caller is the desktop app on the user's own machine,
  // reading the ~/.aws/config that machine already owns.
  const { isAwsLocked } = await import("../middleware/awsHealthMiddleware");
  if (!process.env.ACTIVITY_TABLE || isAwsLocked()) {
    next();
    return;
  }

  authMiddleware(req, res, next);
};

/** After AWS credentials change, try to load GitHub OAuth secrets from Secrets Manager. */
async function reloadSecretsIfNeeded(): Promise<boolean> {
  if (process.env.GITHUB_CLIENT_ID) return false;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const region = awsRegion();
    const secretName = process.env.SECRET_NAME || `${process.env.STACK_NAME || "github-control-hub"}/secrets`;
    const client = new SecretsManagerClient({ region });
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretName }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      for (const key of [
        "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
        "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET",
        "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID",
      ]) {
        if (secrets[key]) process.env[key] = secrets[key];
      }
      if (!process.env.JWT_SECRET) {
        const crypto = await import("crypto");
        process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
      }
      // Initialize GitHub App token manager if credentials were loaded
      if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
        await initTokenManager(process.env.GITHUB_APP_ID, process.env.GITHUB_APP_PRIVATE_KEY, process.env.GITHUB_APP_INSTALLATION_ID);
        console.log("[auth] GitHub App token manager initialized after secrets reload");
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
  }

  unlockAws();
  dynamo.resetDynamoClient();

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const secretsLoaded = await reloadSecretsIfNeeded();
    // Remembered only now, having actually reached DynamoDB. Storing it on the
    // way in would mean a typo becomes the profile you are offered every
    // launch from then on.
    const { rememberAwsProfile } = await import("../services/desktopPrefs");
    if (process.env.AWS_PROFILE) rememberAwsProfile(process.env.AWS_PROFILE);
    res.json({ ok: true, reachable: true, secretsLoaded });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

/** List all AWS profiles from ~/.aws/config and ~/.aws/credentials. */
router.get("/aws-profiles", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (_req: Request, res: Response) => {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const os = await import("os");

    interface ProfileInfo {
      name: string;
      type: "sso" | "iam" | "static";
      accountId?: string;
      roleName?: string;
      region?: string;
      ssoStartUrl?: string;
    }

    const profiles: ProfileInfo[] = [];
    const seen = new Set<string>();
    const ssoSessions = new Map<string, { startUrl?: string }>();

    const configPath = path.join(os.homedir(), ".aws", "config");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const sessionMatch = trimmed.match(/^\[sso-session\s+(.+)]$/);
        if (sessionMatch) {
          const sName = sessionMatch[1];
          const entry: { startUrl?: string } = {};
          for (let j = i + 1; j < lines.length; j++) {
            const l = lines[j].trim();
            if (l.startsWith("[")) break;
            const [k, ...v] = l.split("=");
            if (k?.trim() === "sso_start_url") entry.startUrl = v.join("=").trim();
          }
          ssoSessions.set(sName, entry);
        }
      }

      let current: ProfileInfo | null = null;
      for (const line of lines) {
        const trimmed = line.trim();
        const profileMatch = trimmed.match(/^\[profile\s+(.+)]$/) || trimmed.match(/^\[(default)]$/);
        if (profileMatch) {
          if (current && !seen.has(current.name)) { profiles.push(current); seen.add(current.name); }
          current = { name: profileMatch[1], type: "iam" };
          continue;
        }
        if (!current) continue;
        const [key, ...val] = trimmed.split("=");
        const k = key?.trim();
        const v = val.join("=").trim();
        if (k === "sso_account_id") { current.accountId = v; current.type = "sso"; }
        if (k === "sso_role_name") current.roleName = v;
        if (k === "region") current.region = v;
        if (k === "sso_start_url") { current.ssoStartUrl = v; current.type = "sso"; }
        if (k === "sso_session") {
          current.type = "sso";
          const session = ssoSessions.get(v);
          if (session?.startUrl) current.ssoStartUrl = session.startUrl;
        }
      }
      if (current && !seen.has(current.name)) { profiles.push(current); seen.add(current.name); }
    }

    const credsPath = path.join(os.homedir(), ".aws", "credentials");
    if (fs.existsSync(credsPath)) {
      const content = fs.readFileSync(credsPath, "utf-8");
      for (const line of content.split("\n")) {
        const match = line.trim().match(/^\[(.+)]$/);
        if (match && !seen.has(match[1])) {
          profiles.push({ name: match[1], type: "static" });
          seen.add(match[1]);
        }
      }
    }

    res.json({ profiles });
  } catch (err: any) {
    res.json({ profiles: [], error: err.message });
  }
});

router.post("/aws-sso-login", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { spawn } = await import("child_process");
  const profile = (req.body?.profile as string) || process.env.AWS_PROFILE || "default";

  if (!isValidAwsProfile(profile)) {
    res.status(400).json({ error: "Invalid AWS profile name" });
    return;
  }

  process.env.AWS_PROFILE = profile;

  // GUI-launched apps inherit a minimal PATH, so add the usual CLI install dirs.
  // Join with the platform separator — using ":" on Windows corrupts the last
  // real PATH entry and can leave "aws" unresolvable.
  const nodePath = await import("path");
  const extraPathDirs =
    process.platform === "win32"
      ? [`${process.env.ProgramFiles || "C:\\Program Files"}\\Amazon\\AWSCLIV2`]
      : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin"];
  const env = {
    ...process.env,
    PATH: [process.env.PATH, ...extraPathDirs].filter(Boolean).join(nodePath.delimiter),
  };
  // No shell. With shell:true the argument list is flattened into a command
  // string, so the only thing standing between a profile name and command
  // execution is isValidAwsProfile — which is correct today and is the wrong
  // thing to be relying on. Windows needs the .cmd extension named explicitly
  // once the shell is gone.
  const command = process.platform === "win32" ? "aws.cmd" : "aws";
  const child = spawn(command, ["sso", "login", "--profile", profile], {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    shell: false,
    env,
  });

  // Wait to hear that it started.
  //
  // This used to answer "login started, check your browser" the instant spawn
  // returned, which says nothing about whether anything ran. With stdio
  // ignored and no error listener, a missing AWS CLI produced no browser, no
  // message, and an unhandled 'error' on the child — so the button did
  // nothing, twice over. `spawn` and `error` are the two events that settle
  // this, and one of them always fires.
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
  } catch (err: any) {
    const missing = err?.code === "ENOENT";
    res.status(missing ? 400 : 500).json({
      error: missing
        ? `The AWS CLI is not installed, or not on this app's PATH, so "aws sso login" could not be run. ` +
          `Install it, or use the Access key tab instead — that needs no CLI.`
        : `Could not start "aws sso login": ${err?.message ?? err}`,
      code: missing ? "AWS_CLI_NOT_FOUND" : "AWS_SSO_LAUNCH_FAILED",
    });
    return;
  }

  child.unref();
  res.json({ ok: true, profile, message: `AWS SSO login started for profile "${profile}". Check your browser.` });
});

/** Switch to an existing AWS CLI profile (non-SSO). */
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

  process.env.AWS_PROFILE = profile;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;

  unlockAws();
  dynamo.resetDynamoClient();

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const secretsLoaded = await reloadSecretsIfNeeded();
    const { rememberAwsProfile } = await import("../services/desktopPrefs");
    rememberAwsProfile(profile);
    res.json({ ok: true, reachable: true, secretsLoaded });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

/** Authenticate with explicit access keys. */
router.post("/aws-access-keys", serverModeGuard, sameOriginOnly, setupOrAuthMiddleware, async (req: Request, res: Response) => {
  const { unlockAws } = await import("../middleware/awsHealthMiddleware");
  const dynamo = await import("../utils/dynamo");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");

  const { accessKeyId, secretAccessKey, sessionToken, region } = req.body || {};
  if (!accessKeyId || !secretAccessKey) {
    res.status(400).json({ error: "accessKeyId and secretAccessKey are required" });
    return;
  }

  process.env.AWS_ACCESS_KEY_ID = accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = secretAccessKey;
  if (sessionToken) process.env.AWS_SESSION_TOKEN = sessionToken;
  else delete process.env.AWS_SESSION_TOKEN;
  if (region) process.env.AWS_REGION = region;
  delete process.env.AWS_PROFILE;

  unlockAws();
  dynamo.resetDynamoClient({
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
  });

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    const secretsLoaded = await reloadSecretsIfNeeded();
    res.json({ ok: true, reachable: true, secretsLoaded });
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

router.get("/github", async (req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString("hex");
  await storeOAuthState(state);
  // The login page passes the account it offered to continue with, so GitHub
  // signs in as that one rather than whichever session it happens to hold.
  const login = typeof req.query.login === "string" ? req.query.login : undefined;
  res.redirect(buildAuthorizationUrl(state, login));
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
    const octokit = createOctokit(accessToken);

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
