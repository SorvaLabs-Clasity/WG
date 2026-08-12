/**
 * Sanitize error messages before returning to clients.
 * Logs full error server-side, returns a safe message to the client.
 */
/**
 * Errors whose text is the fix, and which leak nothing.
 *
 * Thrown deliberately by code that knows exactly what is wrong and what to do
 * about it. Turning "the aws-accounts row could not be written because the
 * table does not exist" into "an unexpected error occurred" costs the person
 * reading it an afternoon, and the message contains nothing an attacker wants.
 */
export class ActionableError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ActionableError";
  }
}

export function sanitizeError(err: unknown, context: string): string {
  const message = err instanceof Error ? err.message : String(err);

  console.error(`[${context}]`, err);

  if (err instanceof ActionableError) return message;

  // AWS reports these by exception name; the message alone says "Requested
  // resource not found", which matched nothing below and became "unexpected".
  const name = (err as any)?.name ?? "";
  if (name === "ResourceNotFoundException") {
    return "That data store does not exist yet. Re-run scripts/setup-aws-account.sh against this account to create it.";
  }
  if (name === "AccessDeniedException" || name === "AccessDenied" || name === "UnauthorizedOperation") {
    return "AWS refused that call. The app's IAM role is missing a permission — deploy the CDK stack to update it.";
  }
  if (name === "AWSOrganizationsNotInUseException") {
    return "This AWS account is not part of an organization.";
  }
  if (name === "ExpiredTokenException" || name === "CredentialsProviderError") {
    return "This app's AWS credentials have expired.";
  }

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
