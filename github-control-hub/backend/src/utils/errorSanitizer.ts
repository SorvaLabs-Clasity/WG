/**
 * Sanitize error messages before returning to clients.
 * Logs full error server-side, returns a safe message to the client.
 */
export function sanitizeError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`[${context}]`, err);

  if (/rate limit/i.test(message)) {
    return "GitHub API rate limit exceeded. Please try again later.";
  }
  if (/dynamodb|table.*not found|resourcenotfoundexception/i.test(message)) {
    return "Database operation failed. Please try again.";
  }
  if (/credentials|access.*denied|forbidden|unauthorized/i.test(message)) {
    return "Authorization failed. Please check your permissions.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|network|socket/i.test(message)) {
    return "Service temporarily unavailable. Please try again.";
  }

  // In production, return a generic message to avoid leaking internals
  if (process.env.NODE_ENV === "production") {
    return "An unexpected error occurred. Please try again.";
  }

  // In development, truncate to avoid leaking long stack traces
  return message.length > 200 ? message.slice(0, 200) + "..." : message;
}
