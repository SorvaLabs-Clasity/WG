function getPrefix(): string {
  return process.env.STACK_NAME || "github-control-hub";
}

function getRegion(): string {
  return process.env.AWS_REGION || "us-east-1";
}

function getSecretName(): string {
  return process.env.SECRET_NAME || `${getPrefix()}/secrets`;
}

function resolveTableNames(): void {
  const prefix = getPrefix();
  const tables: Record<string, string> = {
    ACTIVITY_TABLE: `${prefix}-activity`,
    TEMPLATES_TABLE: `${prefix}-templates`,
    SCANNERS_TABLE: `${prefix}-scanners`,
    ALERTS_TABLE: `${prefix}-alerts`,
    ORG_CONFIG_TABLE: `${prefix}-org-config`,
    AUTH_CODES_TABLE: `${prefix}-auth-codes`,
    GRAPH_EDGES_TABLE: `${prefix}-graph-edges`,
    EXCLUSIONS_TABLE: `${prefix}-exclusions`,
    WIDGETS_TABLE: `${prefix}-widgets`,
    COMPLIANCE_CACHE_TABLE: `${prefix}-compliance-cache`,
    RULE_TEMPLATES_TABLE: `${prefix}-rule-templates`,
  };
  for (const [key, val] of Object.entries(tables)) {
    if (!process.env[key]) process.env[key] = val;
  }
}

async function loadSecrets(): Promise<void> {
  if (process.env.GITHUB_CLIENT_ID) return;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({ region: getRegion() });
    const result = await client.send(new GetSecretValueCommand({ SecretId: getSecretName() }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "GITHUB_ORG", "JWT_SECRET"]) {
        if (secrets[key]) process.env[key] = secrets[key];
      }
    }
  } catch (err: any) {
    if (err.name !== "CredentialsProviderError") {
      console.warn(`Warning: Could not load secrets from "${getSecretName()}": ${err.message}`);
    }
  }
}

export async function bootstrap(): Promise<void> {
  if (!process.env.AWS_REGION) process.env.AWS_REGION = getRegion();
  resolveTableNames();
  await loadSecrets();

  if (!process.env.JWT_SECRET) {
    const crypto = await import("crypto");
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  }
}
