import { Router, Request, Response } from "express";
import crypto from "crypto";
import { buildAuthorizationUrl, exchangeCodeForToken } from "../github/oauth";
import { createOctokit, getOrg } from "../github/client";
import { signToken } from "../utils/jwt";
import { docClient, tableName, usesDynamo, PutCommand, GetCommand, DeleteCommand } from "../utils/dynamo";

const router = Router();

const AUTH_CODE_TTL_SEC = 300;

/** In-memory fallback for auth codes when not using DynamoDB (e.g. local dev). */
const memoryAuthCodes = new Map<string, { token: string; expiry: number }>();

async function storeAuthCode(code: string, token: string): Promise<void> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    await docClient.send(
      new PutCommand({
        TableName: table,
        Item: {
          code,
          token,
          ttl: Math.floor(Date.now() / 1000) + AUTH_CODE_TTL_SEC,
        },
      })
    );
  } else {
    memoryAuthCodes.set(code, {
      token,
      expiry: Date.now() + AUTH_CODE_TTL_SEC * 1000,
    });
  }
}

async function consumeAuthCode(code: string): Promise<string | null> {
  if (usesDynamo() && process.env.AUTH_CODES_TABLE) {
    const table = tableName("AUTH_CODES_TABLE");
    const result = await docClient.send(
      new GetCommand({
        TableName: table,
        Key: { code },
      })
    );
    const item = result.Item as { token?: string } | undefined;
    if (!item?.token) return null;
    await docClient.send(
      new DeleteCommand({
        TableName: table,
        Key: { code },
      })
    );
    return item.token;
  }
  const entry = memoryAuthCodes.get(code);
  if (!entry || entry.expiry < Date.now()) return null;
  memoryAuthCodes.delete(code);
  return entry.token;
}

/** Debug: check if Lambda has secrets and env (no values exposed). Remove or restrict in production. */
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

/** Exchange one-time code for JWT (used after OAuth redirect). No auth required. */
router.get("/token", async (req: Request, res: Response) => {
  const code = typeof req.query.code === "string" ? req.query.code.trim() : null;
  if (!code) {
    res.setHeader("Cache-Control", "no-store");
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }
  try {
    const token = await consumeAuthCode(code);
    if (!token) {
      res.setHeader("Cache-Control", "no-store");
      res.status(400).json({ error: "Invalid or expired code" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ token });
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
      res.status(403).json({ error: `User ${user.login} is not a member of ${org}` });
      return;
    }

    const token = signToken({
      githubId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
      accessToken,
    });

    // One-time code: redirect with ?code= so the token isn't in the URL (avoids truncation / stripping by proxies).
    const oneTimeCode = crypto.randomBytes(24).toString("hex");
    await storeAuthCode(oneTimeCode, token);
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    res.redirect(`${frontendUrl}/?code=${oneTimeCode}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Authentication failed";
    console.error("OAuth callback error:", err);
    res.status(500).json({ error: "Authentication failed", detail: message });
  }
});

export default router;
