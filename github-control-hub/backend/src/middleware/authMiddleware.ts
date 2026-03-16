import { Request, Response, NextFunction } from "express";
import { verifyToken, JwtPayload } from "../utils/jwt";
import { getToken } from "../utils/tokenStore";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & { accessToken: string };
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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
