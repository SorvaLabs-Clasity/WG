import { docClient, usesDynamo, tableName, PutCommand, GetCommand } from "../utils/dynamo";

export interface OrgFeatures {
  auditLogs: boolean;
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
}

const TABLE = () => tableName("ORG_CONFIG_TABLE");

// In-memory fallback for local development
let memConfig: OrgConfig = {
  org: process.env.GITHUB_ORG || "",
  features: {
    auditLogs: false,
    rulesetsSupported: true,
    advancedSecurity: false,
  }
};

export async function getOrgConfig(): Promise<OrgConfig> {
  if (usesDynamo()) {
    const org = process.env.GITHUB_ORG || "";
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { org } }));
    if (result.Item) {
      return result.Item as OrgConfig;
    }
    // First access: seed default config
    const defaultConfig: OrgConfig = {
      org,
      features: { auditLogs: false, rulesetsSupported: true, advancedSecurity: false },
    };
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: defaultConfig }));
    return defaultConfig;
  }
  return memConfig;
}

export async function updateOrgFeatures(featureUpdates: Partial<OrgFeatures>): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    features: {
      ...current.features,
      ...featureUpdates,
    },
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }

  return updated;
}
