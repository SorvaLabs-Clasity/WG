import { Request, Response, NextFunction } from "express";
import { docClient } from "../utils/dynamo";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

let lastCheckTime = 0;
let lastCheckResult = true;
const CHECK_INTERVAL_MS = 30_000;

let awsLocked = false;

export function lockAws(): void {
  awsLocked = true;
  lastCheckTime = 0;
  lastCheckResult = false;
}

export function unlockAws(): void {
  awsLocked = false;
  lastCheckTime = 0;
}

export function isAwsLocked(): boolean {
  return awsLocked;
}

/**
 * Drop the cached health verdict, because it was about a different account.
 *
 * `unlockAws()` happens to do this too, and every switch endpoint calls it, so
 * this is belt and braces today. It is here anyway because the next person to
 * change either of them should not have to notice that a lock and an account
 * change are the same thing by coincidence: an account switched into while the
 * last verdict is still warm would otherwise be reported healthy, or refused,
 * on the strength of an answer about somewhere else.
 */
export function resetAwsHealthCache(): void {
  lastCheckTime = 0;
  lastCheckResult = true;
}

/**
 * Exported so the server can pay for it at startup rather than inside the
 * first request.
 *
 * This sits in front of every /api route and awaits a DynamoDB scan before
 * calling next(), and `lastCheckTime` starts at zero, so the thirty-second
 * cache always misses on a freshly started process. Running it once at boot
 * moves that cost, and the whole AWS credential chain underneath it, into the
 * seconds while somebody is still opening the app.
 */
let inFlight: Promise<boolean> | null = null;

export async function isAwsHealthy(): Promise<boolean> {
  if (awsLocked) return false;

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return lastCheckResult;

  /**
   * The check already running, shared rather than started again.
   *
   * `lastCheckTime` is only set once the scan has *finished*, so it cannot stop
   * a burst that all arrives before the first one returns, and a fresh process
   * is exactly that burst. Startup priming begins one check; the page then
   * opens six requests at once, every one of them finds the cache still empty,
   * and every one starts its own scan. On a cold process each of those resolves
   * the whole AWS credential chain underneath it, an SSO round trip and two
   * TLS handshakes, so the first screen after launch paid for seven of them
   * concurrently.
   *
   * Priming moved the cost off the first request. This is what stops it being
   * paid several times over, which is why priming alone did not fix it.
   */
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const table = process.env.ACTIVITY_TABLE;
      if (!table) return false;
      await docClient.send(new ScanCommand({ TableName: table, Limit: 1 }));
      lastCheckResult = true;
    } catch {
      lastCheckResult = false;
    }
    lastCheckTime = Date.now();
    return lastCheckResult;
  })().finally(() => { inFlight = null; });

  return inFlight;
}

export function awsHealthMiddleware(req: Request, res: Response, next: NextFunction): void {
  isAwsHealthy().then((healthy) => {
    if (!healthy) {
      res.status(503).json({
        error: "AWS session expired",
        code: "AWS_SESSION_EXPIRED",
        detail: "DynamoDB is unreachable. Re-authenticate with AWS (aws sso login) and restart the server.",
      });
      return;
    }
    next();
  }).catch(() => {
    res.status(503).json({
      error: "AWS health check failed",
      code: "AWS_SESSION_EXPIRED",
    });
  });
}
