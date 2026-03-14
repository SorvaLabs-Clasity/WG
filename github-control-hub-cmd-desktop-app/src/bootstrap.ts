import path from "path";
import fs from "fs";

const CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "~", ".ghch");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface LocalConfig {
  org?: string;
  region?: string;
  prefix?: string;
}

function loadLocalConfig(): LocalConfig | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function getPrefix(): string {
  return process.env.STACK_NAME || loadLocalConfig()?.prefix || "github-control-hub";
}

function getRegion(): string {
  return process.env.AWS_REGION || loadLocalConfig()?.region || "us-east-1";
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

function resolveOrgFromLocalConfig(): void {
  if (process.env.GITHUB_ORG) return;
  const cfg = loadLocalConfig();
  if (cfg?.org) process.env.GITHUB_ORG = cfg.org;
}

async function loadSecrets(): Promise<void> {
  if (process.env.GITHUB_CLIENT_ID) return;
  try {
    const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
    const client = new SecretsManagerClient({ region: getRegion() });
    const result = await client.send(new GetSecretValueCommand({ SecretId: getSecretName() }));
    if (result.SecretString) {
      const secrets = JSON.parse(result.SecretString) as Record<string, string>;
      for (const key of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SYSTEM_GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET"]) {
        if (secrets[key]) process.env[key] = secrets[key];
      }
    }
  } catch (err: any) {
    if (err.name !== "CredentialsProviderError") {
      console.warn(`Warning: Could not load secrets from "${getSecretName()}": ${err.message}`);
    }
  }
}

async function resolveOrgFromStack(): Promise<void> {
  if (process.env.GITHUB_ORG) return;
  try {
    const { CloudFormationClient, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
    const client = new CloudFormationClient({ region: getRegion() });
    const result = await client.send(new DescribeStacksCommand({ StackName: getPrefix() }));
    const params = result.Stacks?.[0]?.Parameters || [];
    const orgParam = params.find((p) => p.ParameterKey === "GitHubOrg");
    if (orgParam?.ParameterValue) process.env.GITHUB_ORG = orgParam.ParameterValue;
  } catch {}
}

export async function bootstrap(): Promise<void> {
  if (!process.env.AWS_REGION) process.env.AWS_REGION = getRegion();
  resolveTableNames();
  resolveOrgFromLocalConfig();
  await loadSecrets();
  if (!process.env.GITHUB_ORG) await resolveOrgFromStack();

  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = "ghch-desktop-" + Date.now();
}
