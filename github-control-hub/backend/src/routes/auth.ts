import { Router, Request, Response } from "express";
import crypto from "crypto";
import { buildAuthorizationUrl, exchangeCodeForToken } from "../github/oauth";
import { createOctokit, getOrg } from "../github/client";
import { signToken, verifyToken } from "../utils/jwt";
import { docClient, tableName, usesDynamo, PutCommand, GetCommand, DeleteCommand } from "../utils/dynamo";

const router = Router();

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

async function consumeAuthCode(code: string): Promise<AuthCodeEntry | null> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    const result = await docClient.send(
      new GetCommand({ TableName: table, Key: { code } })
    );
    const item = result.Item as (AuthCodeEntry & { code?: string }) | undefined;
    if (!item?.token) return null;
    await docClient.send(
      new DeleteCommand({ TableName: table, Key: { code } })
    );
    return { token: item.token, login: item.login, avatarUrl: item.avatarUrl };
  }
  const entry = memoryAuthCodes.get(code);
  if (!entry || (entry.expiry && entry.expiry < Date.now())) return null;
  memoryAuthCodes.delete(code);
  return entry;
}

router.get("/status", async (_req: Request, res: Response) => {
  const { isAwsLocked } = await import("../middleware/awsHealthMiddleware");
  const awsConnected = !!process.env.ACTIVITY_TABLE;
  const githubConfigured = !!process.env.GITHUB_CLIENT_ID && !!process.env.GITHUB_CLIENT_SECRET;
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
    aws: { connected: awsConnected, dynamoReachable, region: process.env.AWS_REGION || "us-east-1" },
    github: { configured: githubConfigured, org },
  });
});

router.post("/invalidate-aws", async (_req: Request, res: Response) => {
  const { lockAws } = await import("../middleware/awsHealthMiddleware");
  const { resetDynamoClient } = await import("../utils/dynamo");
  lockAws();
  resetDynamoClient();
  res.json({ ok: true });
});

router.post("/reconnect-aws", async (_req: Request, res: Response) => {
  const { unlockAws } = await import("../middleware/awsHealthMiddleware");
  const dynamo = await import("../utils/dynamo");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");

  unlockAws();
  dynamo.resetDynamoClient();

  try {
    await dynamo.docClient.send(new ScanCommand({ TableName: dynamo.tableName("ACTIVITY_TABLE"), Limit: 1 }));
    res.json({ ok: true, reachable: true });
  } catch (err: any) {
    res.json({ ok: true, reachable: false, error: err.message });
  }
});

router.post("/aws-sso-login", async (_req: Request, res: Response) => {
  const { spawn } = await import("child_process");
  const profile = process.env.AWS_PROFILE || "default";

  const child = spawn("aws", ["sso", "login", "--profile", profile], {
    stdio: "ignore",
    detached: true,
    shell: true,
  });
  child.unref();

  res.json({ ok: true, message: `AWS SSO login started for profile "${profile}". Check your browser.` });
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
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    if (clientId && clientSecret && payload.accessToken) {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      await fetch(`https://api.github.com/applications/${clientId}/grant`, {
        method: "DELETE",
        headers: {
          Authorization: `Basic ${credentials}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ access_token: payload.accessToken }),
      });
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[auth/revoke-github] error:", err.message);
    res.json({ ok: true });
  }
});

router.get("/debug", (_req: Request, res: Response) => {
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

router.get("/github", (_req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString("hex");
  const url = buildAuthorizationUrl(state);
  res.redirect(url);
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
  const { code } = req.query;
  const queryKeys = Object.keys(req.query || {});
  console.log("[auth/callback] query keys:", queryKeys, "code type:", typeof code);

  if (typeof code !== "string") {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({
      error: "Missing code parameter",
      debug: { queryKeys, hasCode: "code" in (req.query || {}) },
    });
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

    const token = signToken({
      githubId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
      accessToken,
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
