function getPrefix(): string {
  return process.env.STACK_NAME || "github-control-hub";
}

function getRegion(): string {
  // No literal. An empty string leaves the AWS SDK to resolve the region from
  // the signed-in profile, which is the only thing that knows it — naming one
  // here overrode the profile and read a different account's tables.
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "";
}

function getSecretName(): string {
  return process.env.SECRET_NAME || `${getPrefix()}/secrets`;
}

function resolveTableNames(): void {
  const prefix = getPrefix();
  const tables: Record<string, string> = {
    ACTIVITY_TABLE: `${prefix}-activity`,
    SCANNERS_TABLE: `${prefix}-scanners`,
    ALERTS_TABLE: `${prefix}-alerts`,
    ORG_CONFIG_TABLE: `${prefix}-org-config`,
    AUTH_CODES_TABLE: `${prefix}-auth-codes`,
    GRAPH_EDGES_TABLE: `${prefix}-graph-edges`,
    WIDGETS_TABLE: `${prefix}-widgets`,
    COMPLIANCE_CACHE_TABLE: `${prefix}-compliance-cache`,
    ALARMS_TABLE: `${prefix}-alarms`,
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
      // No GITHUB_WEBHOOK_SECRET: it lives in its own secret and only the
      // receiver Lambda reads it. Nothing here verifies signatures.
      //
      // No SYSTEM_GITHUB_TOKEN either. That fallback personal access token was
      // removed from client.ts, from the server's own startup load, from the
      // webhook worker's bundle and from the alarm handler — this was the last
      // loader still copying it out of Secrets Manager, into the environment of
      // a long-lived desktop process, where every child it spawns inherits it.
      // `aws sso login` is spawned with `...process.env`, so a classic PAT with
      // admin:org was being handed to the AWS CLI to hold nothing back with.
      for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_ORG", "JWT_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"]) {
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
  // Only when there is something to set. Assigning the empty string getRegion()
  // returns is what put `region: ""` into the SDK — and an empty region is
  // worse than an absent one, because it overrides the resolver instead of
  // deferring to it. awsRegion() treats "" as absent, but nothing should have
  // to know that; the variable is simply left unset when nobody named a region.
  const region = getRegion();
  if (region && !process.env.AWS_REGION) process.env.AWS_REGION = region;
  resolveTableNames();
  await loadSecrets();

  // Token manager initialization is handled by server.ts after it loads

  if (!process.env.JWT_SECRET) {
    const crypto = await import("crypto");
    process.env.JWT_SECRET = crypto.randomBytes(32).toString("hex");
  }
}
