/**
 * Tests for rate-limit detection.
 *
 * GitHub reports two different problems through the same 403, and they need
 * different answers: one is "wait until the hour turns over", the other is
 * "wait twenty seconds". Getting it wrong tells someone to wait an hour for
 * something that clears immediately, or the reverse.
 *
 * A plain 403 must NOT be read as a rate limit — that is a permission refusal
 * and has its own message.
 */
import { parseRateLimit } from "./src/utils/rateLimit";

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
  if (!ok) failures++;
}

const RESET = Math.floor(Date.now() / 1000) + 1800;

/** The shape Octokit throws. */
const ghError = (status: number, message: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error(message), { status, response: { headers } });

// ── primary: the hourly budget is spent ──────────────────────────────
{
  const err = ghError(403, "API rate limit exceeded for installation ID 12345.", {
    "x-ratelimit-limit": "12500", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET),
  });
  const info = parseRateLimit(err);
  check("primary limit is recognised", info?.kind === "primary", info);
  check("  reset time is carried through",
    info?.resetAt === new Date(RESET * 1000).toISOString(), info?.resetAt);
  check("  so is the limit, for the message", info?.limit === 12500, info?.limit);
}

// ── secondary: too fast, clears quickly ──────────────────────────────
{
  const err = ghError(403, "You have exceeded a secondary rate limit. Please wait a few minutes.", {
    "retry-after": "23", "x-ratelimit-remaining": "4210",
  });
  const info = parseRateLimit(err);
  check("secondary limit is recognised", info?.kind === "secondary", info);
  check("  retry-after is carried through", info?.retryAfter === 23, info?.retryAfter);
}

{
  // Secondary limits do not always name themselves; retry-after with budget
  // still remaining is the tell.
  const info = parseRateLimit(ghError(403, "Forbidden", { "retry-after": "60", "x-ratelimit-remaining": "3000" }));
  check("a retry-after with budget left is secondary, not primary", info?.kind === "secondary", info);
}

// ── the important negative ───────────────────────────────────────────
{
  const denied = ghError(403, "Resource not accessible by integration", { "x-ratelimit-remaining": "4998" });
  check("a permission 403 is NOT read as a rate limit", parseRateLimit(denied) === null, parseRateLimit(denied));

  check("a 404 is not", parseRateLimit(ghError(404, "Not Found")) === null);
  check("a 500 is not", parseRateLimit(ghError(500, "Server Error")) === null);
  check("an ordinary Error is not", parseRateLimit(new Error("socket hang up")) === null);
  check("undefined is not", parseRateLimit(undefined) === null);
}

// ── 429, which GitHub also uses ──────────────────────────────────────
{
  const info = parseRateLimit(ghError(429, "Too Many Requests", {
    "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET),
  }));
  check("a 429 is handled as well as a 403", info?.kind === "primary", info);
}

// ── missing headers must not throw ───────────────────────────────────
{
  const info = parseRateLimit(ghError(403, "API rate limit exceeded"));
  check("a rate limit with no headers is still recognised", info?.kind === "primary", info);
  check("  and simply has no reset time", info?.resetAt === undefined, info?.resetAt);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
