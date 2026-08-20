import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtPayload } from "../utils/jwt";
import { getToken, removeToken } from "../utils/tokenStore";
import { isStillOrgMember, forgetMembership } from "../services/orgMembership";
import { getOrg } from "../github/client";
import { hasGithubCredentials } from "./githubGate";

/**
 * Is there an organization to ask about at all?
 *
 * Every request re-asks GitHub whether the caller is still an org member, which
 * is the right question in the account where GitHub lives. Switching to an
 * account whose secret holds nothing GitHub-shaped leaves no organization
 * configured, and asking anyway throws inside the check — which
 * `isStillOrgMember` reads as "could not ask" and degrades to *not a member*
 * once its cached yes ages out. The session then ended about an hour after the
 * switch, which reads as a random logout rather than as a consequence of it.
 *
 * So the check is skipped exactly where it cannot be answered. Nothing is
 * loosened by that: an account with no GitHub credentials has no GitHub half —
 * githubGateMiddleware refuses every route that touches it — and what remains
 * is the AWS tab, whose own permissions are read from GitHub with the caller's
 * token a moment later.
 */
export function membershipCheckable(): boolean {
  return hasGithubCredentials() && !!process.env.GITHUB_ORG;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & { accessToken: string };
    }
  }
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  try {
    const payload = verifyToken(header.slice(7));
    const accessToken = getToken(payload.githubId);
    if (!accessToken) {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }

    // Membership was verified at login and then trusted for the life of the
    // token. Someone removed from the organization kept working until it
    // expired, which is not what anyone means by removing access.
    if (membershipCheckable()
        && !await isStillOrgMember(payload.githubId, payload.login, accessToken)) {
      forgetMembership(payload.githubId);
      removeToken(payload.githubId);
      res.status(403).json({
        error: `${payload.login} is no longer a member of the ${getOrg()} organization.`,
        code: "ORG_MEMBERSHIP_REVOKED",
      });
      return;
    }

    req.user = { ...payload, accessToken };
    next();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    // Server can't verify (e.g. JWT_SECRET not loaded yet on cold start) -> 503 so client doesn't clear token
    if (msg.includes("JWT_SECRET") || msg.includes("required")) {
      res.status(503).json({ error: "Service temporarily unavailable", detail: "Auth not ready" });
      return;
    }
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
