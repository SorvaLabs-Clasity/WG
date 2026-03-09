import { Octokit } from "octokit";

export function createOctokit(token: string): Octokit {
  return new Octokit({ auth: token });
}

export function getOrg(): string {
  const org = process.env.GITHUB_ORG;
  if (!org) throw new Error("GITHUB_ORG environment variable is required");
  return org;
}

export async function checkAuditLogAccess(octokit: Octokit): Promise<boolean> {
  const org = getOrg();
  try {
    // Attempt to fetch 1 item from the audit log
    await octokit.request("GET /orgs/{org}/audit-log", {
      org,
      per_page: 1,
    });
    return true;
  } catch (error: any) {
    if (error.status === 403 || error.status === 404) {
      return false;
    }
    // If it fails for another reason (e.g., network error), we might log it, 
    // but we can assume false or re-throw. Assuming false for safety.
    console.error("Error checking audit log access:", error);
    return false;
  }
}
