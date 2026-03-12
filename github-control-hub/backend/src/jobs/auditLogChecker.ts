import { createOctokit, checkAuditLogAccess } from "../github/client";
import { updateOrgFeatures } from "../services/orgConfigService";

async function ensureSecrets() {
  if (process.env.SYSTEM_GITHUB_TOKEN) return;
  const secretId = process.env.SECRET_NAME;
  if (!secretId) return;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({});
    const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      if (secrets.SYSTEM_GITHUB_TOKEN) process.env.SYSTEM_GITHUB_TOKEN = secrets.SYSTEM_GITHUB_TOKEN;
    }
  } catch (err) {
    console.error("[AuditLogChecker] Failed to load secrets:", err);
  }
}

export async function runAuditLogCheckJob() {
  console.log("[AuditLogChecker] Starting scheduled audit log access check...");

  await ensureSecrets();
  const token = process.env.SYSTEM_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!token) {
    console.warn("[AuditLogChecker] SYSTEM_GITHUB_TOKEN is not set. Cannot perform check.");
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

export const handler = async (event: any) => {
  await runAuditLogCheckJob();
};
