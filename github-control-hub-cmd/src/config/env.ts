import "dotenv/config";
import path from "path";
import fs from "fs";

const CONFIG_DIR = path.join(process.env.HOME || "~", ".ghch");
const CREDS_FILE = path.join(CONFIG_DIR, "credentials.json");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getCredsFile(): string {
  return CREDS_FILE;
}

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

export function getOrg(): string {
  const org = process.env.GITHUB_ORG;
  if (!org) {
    console.error("Error: GITHUB_ORG not resolved. Run 'ghch setup' or set GITHUB_ORG env var.");
    process.exit(1);
  }
  return org;
}

export function getClientId(): string {
  const id = process.env.GITHUB_CLIENT_ID;
  if (!id) {
    console.error("Error: GITHUB_CLIENT_ID not resolved. Run 'ghch setup' or check AWS credentials.");
    process.exit(1);
  }
  return id;
}

let _bootstrapped = false;

/**
 * Auto-resolve all config at startup:
 * 1. Table names — derived from prefix (default "github-control-hub")
 * 2. Org name — from local config (~/.ghch/config.json), CloudFormation stack, or env var
 * 3. Secrets — from Secrets Manager (GITHUB_CLIENT_ID, etc.)
 *
 * Works in both scenarios:
 * - CLI-only mode: tables created by "ghch setup", org stored locally
 * - Web app mode: tables created by CloudFormation, org resolved from stack params
 */
export async function bootstrap(): Promise<void> {
  if (_bootstrapped) return;

  resolveTableNames();
  resolveOrgFromLocalConfig();
  await loadSecrets();
  if (!process.env.GITHUB_ORG) await resolveOrgFromStack();

  _bootstrapped = true;
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
      if (secrets.GITHUB_CLIENT_ID) process.env.GITHUB_CLIENT_ID = secrets.GITHUB_CLIENT_ID;
      if (secrets.GITHUB_CLIENT_SECRET) process.env.GITHUB_CLIENT_SECRET = secrets.GITHUB_CLIENT_SECRET;
      if (secrets.SYSTEM_GITHUB_TOKEN) process.env.SYSTEM_GITHUB_TOKEN = secrets.SYSTEM_GITHUB_TOKEN;
      if (secrets.GITHUB_WEBHOOK_SECRET) process.env.GITHUB_WEBHOOK_SECRET = secrets.GITHUB_WEBHOOK_SECRET;
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
    if (orgParam?.ParameterValue) {
      process.env.GITHUB_ORG = orgParam.ParameterValue;
    }
  } catch {
    // Non-fatal: will be caught by getOrg() if still missing
  }
}
