import { Command } from "commander";
import inquirer from "inquirer";
import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { heading, success, info, warn, error, spinner, chalk } from "../utils/output";
import { ensureConfigDir, getConfigDir } from "../config/env";
import fs from "fs";
import path from "path";

const STACK_PREFIX = process.env.STACK_NAME || "github-control-hub";
const REGION = process.env.AWS_REGION || "us-east-1";
const SECRET_NAME = process.env.SECRET_NAME || "github-control-hub/secrets";

interface TableDef {
  suffix: string;
  envVar: string;
  keys: { name: string; type: "HASH" | "RANGE" }[];
  ttlAttr?: string;
}

const TABLES: TableDef[] = [
  { suffix: "activity",         envVar: "ACTIVITY_TABLE",         keys: [{ name: "pk", type: "HASH" }, { name: "sk", type: "RANGE" }] },
  { suffix: "templates",        envVar: "TEMPLATES_TABLE",        keys: [{ name: "id", type: "HASH" }] },
  { suffix: "scanners",         envVar: "SCANNERS_TABLE",         keys: [{ name: "pk", type: "HASH" }, { name: "sk", type: "RANGE" }] },
  { suffix: "alerts",           envVar: "ALERTS_TABLE",           keys: [{ name: "id", type: "HASH" }] },
  { suffix: "org-config",       envVar: "ORG_CONFIG_TABLE",       keys: [{ name: "org", type: "HASH" }] },
  { suffix: "auth-codes",       envVar: "AUTH_CODES_TABLE",       keys: [{ name: "code", type: "HASH" }], ttlAttr: "ttl" },
  { suffix: "graph-edges",      envVar: "GRAPH_EDGES_TABLE",      keys: [{ name: "pk", type: "HASH" }, { name: "sk", type: "RANGE" }] },
  { suffix: "exclusions",       envVar: "EXCLUSIONS_TABLE",       keys: [{ name: "id", type: "HASH" }] },
  { suffix: "widgets",          envVar: "WIDGETS_TABLE",          keys: [{ name: "id", type: "HASH" }] },
  { suffix: "compliance-cache", envVar: "COMPLIANCE_CACHE_TABLE", keys: [{ name: "repo", type: "HASH" }] },
];

async function tableExists(ddb: DynamoDBClient, name: string): Promise<boolean> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") return false;
    throw err;
  }
}

async function createTable(ddb: DynamoDBClient, tableName: string, def: TableDef): Promise<void> {
  const attrDefs = def.keys.map((k) => ({ AttributeName: k.name, AttributeType: "S" as const }));
  const keySchema = def.keys.map((k) => ({ AttributeName: k.name, KeyType: k.type }));

  await ddb.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: attrDefs,
    KeySchema: keySchema,
  }));
}

async function secretExists(sm: SecretsManagerClient, secretId: string): Promise<boolean> {
  try {
    await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
    return true;
  } catch (err: any) {
    if (err.name === "ResourceNotFoundException") return false;
    if (err.name === "InvalidRequestException") return false;
    throw err;
  }
}

export function registerSetupCommands(program: Command): void {
  program
    .command("setup")
    .description("Create DynamoDB tables and Secrets Manager secret (for CLI-only mode)")
    .option("--region <region>", "AWS region", REGION)
    .option("--prefix <prefix>", "Table name prefix", STACK_PREFIX)
    .action(async (opts) => {
      heading("GitHub Control Hub — Setup");
      info("This creates the DynamoDB tables and Secrets Manager secret needed by the CLI.");
      info("If you already have the web app deployed, tables will be detected and skipped.\n");

      const ddb = new DynamoDBClient({ region: opts.region });
      const sm = new SecretsManagerClient({ region: opts.region });
      const prefix = opts.prefix;

      // --- DynamoDB Tables ---
      info("Checking DynamoDB tables…");
      let created = 0;
      let skipped = 0;

      for (const def of TABLES) {
        const tableName = `${prefix}-${def.suffix}`;
        const s = spinner(`  ${tableName}`);
        s.start();

        if (await tableExists(ddb, tableName)) {
          s.stop();
          console.log(`  ${chalk.gray("●")} ${tableName} ${chalk.gray("— already exists, skipped")}`);
          skipped++;
        } else {
          try {
            await createTable(ddb, tableName, def);
            s.stop();
            console.log(`  ${chalk.green("●")} ${tableName} ${chalk.green("— created")}`);
            created++;
          } catch (err: any) {
            s.stop();
            console.log(`  ${chalk.red("●")} ${tableName} ${chalk.red(`— failed: ${err.message}`)}`);
          }
        }
      }

      console.log();
      if (created > 0) success(`Created ${created} table(s).`);
      if (skipped > 0) info(`Skipped ${skipped} table(s) (already exist).`);

      // --- Secrets Manager ---
      console.log();
      info("Checking Secrets Manager…");
      const secretName = process.env.SECRET_NAME || `${prefix}/secrets`;

      if (await secretExists(sm, secretName)) {
        info(`Secret "${secretName}" already exists. Skipped.`);
      } else {
        const { createSecret } = await inquirer.prompt([
          { type: "confirm", name: "createSecret", message: `Secret "${secretName}" not found. Create it now?`, default: true },
        ]);

        if (createSecret) {
          const secrets = await inquirer.prompt([
            { type: "input", name: "GITHUB_CLIENT_ID", message: "GitHub OAuth App Client ID:", validate: (v: string) => v.length > 0 || "Required" },
            { type: "password", name: "GITHUB_CLIENT_SECRET", message: "GitHub OAuth App Client Secret:", mask: "*", validate: (v: string) => v.length > 0 || "Required" },
            { type: "input", name: "GITHUB_ORG", message: "GitHub Organization name:", validate: (v: string) => v.length > 0 || "Required" },
          ]);

          const secretValue: Record<string, string> = {
            GITHUB_CLIENT_ID: secrets.GITHUB_CLIENT_ID,
            GITHUB_CLIENT_SECRET: secrets.GITHUB_CLIENT_SECRET,
          };

          try {
            await sm.send(new CreateSecretCommand({
              Name: secretName,
              SecretString: JSON.stringify(secretValue),
            }));
            success(`Secret "${secretName}" created.`);
          } catch (err: any) {
            error(`Failed to create secret: ${err.message}`);
          }

          // Save org locally
          saveLocalConfig({ org: secrets.GITHUB_ORG, region: opts.region, prefix });
        }
      }

      // --- Save local config ---
      if (!loadLocalConfig()) {
        const { org } = await inquirer.prompt([
          { type: "input", name: "org", message: "GitHub Organization name (for local config):", validate: (v: string) => v.length > 0 || "Required" },
        ]);
        saveLocalConfig({ org, region: opts.region, prefix });
      }

      console.log();
      success("Setup complete. Run 'ghch login' to authenticate.");
    });

  program
    .command("teardown")
    .description("Delete all DynamoDB tables created by setup (DESTRUCTIVE)")
    .option("--region <region>", "AWS region", REGION)
    .option("--prefix <prefix>", "Table name prefix", STACK_PREFIX)
    .action(async (opts) => {
      heading("GitHub Control Hub — Teardown");
      warn("This will DELETE all DynamoDB tables and their data. This cannot be undone.\n");

      const { confirm } = await inquirer.prompt([
        { type: "confirm", name: "confirm", message: "Are you sure you want to delete all tables?", default: false },
      ]);
      if (!confirm) {
        info("Aborted.");
        return;
      }

      const { doubleConfirm } = await inquirer.prompt([
        { type: "input", name: "doubleConfirm", message: `Type "${opts.prefix}" to confirm:` },
      ]);
      if (doubleConfirm !== opts.prefix) {
        info("Aborted. Input did not match.");
        return;
      }

      const { DynamoDBClient, DeleteTableCommand } = await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({ region: opts.region });

      for (const def of TABLES) {
        const tableName = `${opts.prefix}-${def.suffix}`;
        try {
          if (await tableExists(ddb, tableName)) {
            await ddb.send(new DeleteTableCommand({ TableName: tableName }));
            success(`Deleted: ${tableName}`);
          } else {
            info(`Skipped: ${tableName} (not found)`);
          }
        } catch (err: any) {
          error(`Failed to delete ${tableName}: ${err.message}`);
        }
      }

      console.log();
      success("Teardown complete.");
    });
}

interface LocalConfig {
  org: string;
  region: string;
  prefix: string;
}

function localConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function saveLocalConfig(cfg: LocalConfig): void {
  ensureConfigDir();
  fs.writeFileSync(localConfigPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function loadLocalConfig(): LocalConfig | null {
  const p = localConfigPath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
