import { Response } from "express";

/**
 * Turns GitHub's rate-limit refusals into an answer a person can act on.
 *
 * GitHub reports two different things through the same 403, and a generic 500
 * reads as "the app is broken" rather than "wait four minutes":
 *
 *   Primary, the hourly budget is spent. `x-ratelimit-remaining: 0`, and
 *               `x-ratelimit-reset` says when it refills. Nothing helps but
 *               waiting, so the time is the only useful thing to show.
 *   Secondary, too much too fast, or too many concurrent requests. Carries
 *               `retry-after` in seconds and clears in well under a minute.
 */

export interface RateLimitInfo {
  kind: "primary" | "secondary";
  /** When the budget refills, ISO 8601. */
  resetAt?: string;
  /** Seconds to wait, when GitHub says so directly. */
  retryAfter?: number;
  limit?: number;
  /**
   * Which budget was spent: "core", "search", "graphql", or undefined where
   * GitHub did not say.
   *
   * The three are separate allowances in different units, and conflating them
   * produced the most confusing message this app has shown: a search limit,
   * which is thirty requests a *minute*, described as the hourly budget being
   * spent, next to a usage screen reporting eight requests for the hour. Both
   * numbers were right. Undefined stays undefined rather than defaulting to
   * core, because naming a budget nobody reported is a confident wrong answer.
   */
  resource?: string;
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
    resource: header(err, "x-ratelimit-resource"),
  };
}

export function describeRateLimit(info: RateLimitInfo): string {
  if (info.kind === "secondary") {
    return "GitHub is asking us to slow down, too many requests in a short window"
      + (info.retryAfter ? `. It asked for about ${info.retryAfter} seconds` : "")
      + ". This clears on its own in under a minute.";
  }

  // Search is the one people meet, and the one the usage screen cannot
  // explain: its allowance is per minute, so a minute of searching exhausts it
  // inside an hour whose total is single digits.
  if (info.resource === "search") {
    return "GitHub's search allowance is spent"
      + (info.limit ? ` (${info.limit} searches per minute)` : " (thirty searches per minute)")
      + ". It is a separate, much smaller budget than the hourly one, and it "
      + "refills within the minute.";
  }

  if (info.resource === "graphql") {
    return "GitHub's GraphQL allowance is spent"
      + (info.limit ? ` (${info.limit.toLocaleString()} points per hour)` : "")
      + ". That is a separate budget from ordinary requests, counted in points "
      + "rather than calls.";
  }

  return "GitHub's hourly request budget for this organization is spent" +
    (info.limit ? ` (${info.limit.toLocaleString()} requests per hour)` : "") +
    ". Everything that reads from GitHub will fail until it refills.";
}

/** Kept for callers written before the description was worth exporting. */
function describe(info: RateLimitInfo): string {
  return describeRateLimit(info);
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
    resource: info.resource,
    resetAt: info.resetAt,
    retryAfter: info.retryAfter,
    limit: info.limit,
  });
  return true;
}
