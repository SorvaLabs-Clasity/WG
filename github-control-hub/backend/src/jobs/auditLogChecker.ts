import { createOctokit, checkAuditLogAccess } from "../github/client";
import { updateOrgFeatures } from "../services/orgConfigService";

const SYSTEM_GITHUB_TOKEN = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

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
      await updateOrgFeatures({ auditLogs: true });
    } else {
      console.log("[AuditLogChecker] Denied (403/404): Organization does NOT have GitHub Enterprise Audit Log access.");
      await updateOrgFeatures({ auditLogs: false });
    }
  } catch (error) {
    console.error("[AuditLogChecker] Unexpected error during check:", error);
  }
}

export const handler = async (event: any) => {
  await runAuditLogCheckJob();
};
