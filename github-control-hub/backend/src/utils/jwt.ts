import jwt from "jsonwebtoken";

const isProduction = process.env.NODE_ENV === "production";

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret && isProduction) {
    throw new Error("JWT_SECRET is required in production");
  }
  return secret || "dev-secret-change-me";
}

export interface JwtPayload {
  githubId: number;
  login: string;
  avatarUrl: string;
  accessToken: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), { expiresIn: "8h" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret()) as JwtPayload;
}
