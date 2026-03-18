import { createOctokit, checkAuditLogAccess, getSystemTokenAsync } from "../github/client";
import { updateOrgFeatures } from "../services/orgConfigService";

export async function runAuditLogCheckJob() {
  console.log("[AuditLogChecker] Starting scheduled audit log access check...");

  const token = await getSystemTokenAsync();
  if (!token) {
    console.warn("[AuditLogChecker] No GitHub token available. Cannot perform check.");
    return;
  }

  const octokit = createOctokit(token);
  
  try {
    const hasAccess = await checkAuditLogAccess(octokit);
    
    if (hasAccess) {
      console.log("[AuditLogChecker] Success: Organization has GitHub Enterprise Audit Log access.");
      await updateOrgFeatures({ auditLogs: true });
    } else {
      console.log("[AuditLogChecker] Denied (403/404): Organization does NOT have GitHub Enterprise Audit Log access.");
      await updateOrgFeatures({ auditLogs: false });
    }
  } catch (error) {
    console.error("[AuditLogChecker] Unexpected error during check:", error);
  }
}
