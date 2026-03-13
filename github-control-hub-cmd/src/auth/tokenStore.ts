/**
 * Returns the system GitHub token (loaded from Secrets Manager during bootstrap).
 * Used by CLI commands that need GitHub API access.
 */
export function requireToken(): { accessToken: string; login: string } {
  const token = process.env.SYSTEM_GITHUB_TOKEN;
  if (!token) {
    console.error("Error: No GitHub token available. Ensure SYSTEM_GITHUB_TOKEN is set in Secrets Manager.");
    process.exit(1);
  }
  return { accessToken: token, login: "system" };
}
