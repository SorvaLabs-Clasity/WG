import { Response } from "express";

/**
 * Turns GitHub's rate-limit refusals into an answer a person can act on.
 *
 * GitHub reports two different things through the same 403:
 *
 *   Primary   — the hourly budget is spent. `x-ratelimit-remaining: 0`, and
 *               `x-ratelimit-reset` says when it refills. Nothing helps but
 *               waiting, so the time is the only useful thing to show.
 *   Secondary — too much too fast, or too many concurrent requests. Carries
 *               `retry-after` in seconds and clears in well under a minute.
 *
 * Both used to surface as a generic 500, which reads as "the app is broken"
 * rather than "wait four minutes". Only the Dependabot route handled it, and
 * that route is not the only one that can exhaust the budget.
 */

export interface RateLimitInfo {
  kind: "primary" | "secondary";
  /** When the budget refills, ISO 8601. */
  resetAt?: string;
  /** Seconds to wait, when GitHub says so directly. */
  retryAfter?: number;
  limit?: number;
}

function header(err: unknown, name: string): string | undefined {
  const h = (err as { response?: { headers?: Record<string, unknown> } })?.response?.headers;
  const v = h?.[name];
  return v === undefined || v === null ? undefined : String(v);
}

/** Rate-limit details, or null when this error is something else. */
export function parseRateLimit(err: unknown): RateLimitInfo | null {
  const status = (err as { status?: number })?.status;
  if (status !== 403 && status !== 429) return null;

  const message = String((err as { message?: string })?.message ?? "");
  const remaining = header(err, "x-ratelimit-remaining");
  const retryAfter = header(err, "retry-after");

  const secondary = /secondary rate limit/i.test(message) || (!!retryAfter && remaining !== "0");
  const primary = remaining === "0" || /rate limit/i.test(message);
  if (!secondary && !primary) return null;

  const reset = header(err, "x-ratelimit-reset");
  return {
    kind: secondary ? "secondary" : "primary",
    resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : undefined,
    retryAfter: retryAfter ? Number(retryAfter) : undefined,
    limit: header(err, "x-ratelimit-limit") ? Number(header(err, "x-ratelimit-limit")) : undefined,
  };
}

function describe(info: RateLimitInfo): string {
  if (info.kind === "secondary") {
    return "GitHub is asking us to slow down — too many requests in a short window. " +
      "This clears on its own in under a minute.";
  }
  return "GitHub's hourly request budget for this organisation is spent" +
    (info.limit ? ` (${info.limit.toLocaleString()} requests per hour)` : "") +
    ". Everything that reads from GitHub will fail until it refills.";
}

/**
 * Sends a 429 describing the wait, and reports whether it handled the error.
 *
 * 429 rather than passing GitHub's 403 through, because a 403 from us means
 * "you are not allowed" everywhere else in this app, and the client turns that
 * into a permissions message.
 */
export function sendIfRateLimited(res: Response, err: unknown): boolean {
  const info = parseRateLimit(err);
  if (!info) return false;

  res.status(429).json({
    error: describe(info),
    code: "GITHUB_RATE_LIMITED",
    kind: info.kind,
    resetAt: info.resetAt,
    retryAfter: info.retryAfter,
    limit: info.limit,
  });
  return true;
}
