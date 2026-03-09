import { createOctokit, checkAuditLogAccess } from "../github/client";
import { updateOrgFeatures } from "../services/orgConfigService";

const SYSTEM_GITHUB_TOKEN = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

/**
 * Scheduled job to verify if the organization has access to GitHub Enterprise Audit Logs.
 * Should be triggered by AWS EventBridge every 6 hours.
 */
export async function runAuditLogCheckJob() {
  console.log("[AuditLogChecker] Starting scheduled audit log access check...");
  
  if (!SYSTEM_GITHUB_TOKEN) {
    console.warn("[AuditLogChecker] SYSTEM_GITHUB_TOKEN is not set. Cannot perform check.");
    return;
  }

  const octokit = createOctokit(SYSTEM_GITHUB_TOKEN);
  
  try {
    const hasAccess = await checkAuditLogAccess(octokit);
    
    if (hasAccess) {
      console.log("[AuditLogChecker] Success: Organization has GitHub Enterprise Audit Log access.");
      updateOrgFeatures({ auditLogs: true });
      // Here you would also enable the audit log ingestion pipeline (e.g., triggering a separate polling job)
    } else {
      console.log("[AuditLogChecker] Denied (403/404): Organization does NOT have GitHub Enterprise Audit Log access.");
      updateOrgFeatures({ auditLogs: false });
      // We rely solely on webhooks in this case.
    }
  } catch (error) {
    console.error("[AuditLogChecker] Unexpected error during check:", error);
  }
}

// If this file is executed directly (e.g., as a Lambda handler)
export const handler = async (event: any) => {
  await runAuditLogCheckJob();
};
