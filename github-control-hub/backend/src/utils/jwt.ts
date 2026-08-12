import jwt from "jsonwebtoken";

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }
  return secret;
}

export interface JwtPayload {
  githubId: number;
  login: string;
  avatarUrl: string;
}

/**
 * One algorithm, named on both sides.
 *
 * Neither call stated one, which left the accepted set to whatever the library
 * infers from the key. That inference is the thing every JWT algorithm-confusion
 * bug has gone through, and it is a property of a dependency rather than of this
 * file — so it can change under us in a patch release. This app issues exactly
 * one kind of token, with a symmetric secret, and can say so.
 */
const ALGORITHM = "HS256" as const;

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, getSecret(), { algorithm: ALGORITHM, expiresIn: "8h" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] }) as JwtPayload;
}
