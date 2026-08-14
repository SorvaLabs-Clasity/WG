import crypto from "crypto";

/**
 * The bytes GitHub signed, whatever encoding API Gateway wrapped them in.
 *
 * The signature covers the request body exactly as sent. API Gateway may
 * base64-encode it, so the flag decides the decoding — and nothing may parse
 * and re-serialise the payload before this runs, because a re-serialised body
 * is a different sequence of bytes and every signature fails.
 */
export function rawBodyBytes(body: string | undefined, isBase64Encoded: boolean): Buffer {
  return Buffer.from(body ?? "", isBase64Encoded ? "base64" : "utf8");
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!secret) return false;
  if (!signatureHeader) return false;

  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    // timingSafeEqual throws when the lengths differ, which is what a
    // malformed header looks like.
    return false;
  }
}
