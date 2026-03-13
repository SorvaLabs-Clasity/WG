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

async function isAwsHealthy(): Promise<boolean> {
  if (awsLocked) return false;

  const now = Date.now();
  if (now - lastCheckTime < CHECK_INTERVAL_MS) return lastCheckResult;

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
