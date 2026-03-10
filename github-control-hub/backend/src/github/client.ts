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

/** Org audit log event shape (GitHub API). */
export interface OrgAuditLogEvent {
  "@timestamp"?: number;
  action?: string;
  actor?: string;
  actor_id?: number;
  user?: string;
  org?: string;
  repo?: string;
  created_at?: number;
  data?: Record<string, unknown>;
}

/** Fetch recent org audit log events (Enterprise / orgs with audit log). */
export async function fetchOrgAuditLog(
  octokit: Octokit,
  options: { per_page?: number; page?: number; phrase?: string } = {}
): Promise<OrgAuditLogEvent[]> {
  const org = getOrg();
  const res = await octokit.request("GET /orgs/{org}/audit-log", {
    org,
    per_page: options.per_page ?? 50,
    page: options.page ?? 1,
    phrase: options.phrase,
    order: "desc",
  });
  return (res.data as OrgAuditLogEvent[]) || [];
}
