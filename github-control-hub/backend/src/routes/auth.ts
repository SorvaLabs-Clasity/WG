import { Router, Request, Response } from "express";
import crypto from "crypto";
import { buildAuthorizationUrl, exchangeCodeForToken } from "../github/oauth";
import { createOctokit, getOrg } from "../github/client";
import { signToken } from "../utils/jwt";

const router = Router();

router.get("/github", (_req: Request, res: Response) => {
  const state = crypto.randomBytes(16).toString("hex");
  const url = buildAuthorizationUrl(state);
  res.redirect(url);
});

router.get("/github/callback", async (req: Request, res: Response) => {
  const { code } = req.query;
  if (typeof code !== "string") {
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
      res.status(403).json({ error: `User ${user.login} is not a member of ${org}` });
      return;
    }

    const token = signToken({
      githubId: user.id,
      login: user.login,
      avatarUrl: user.avatar_url,
      accessToken,
    });

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    res.redirect(`${frontendUrl}/auth/callback?token=${token}`);
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
});

export default router;
