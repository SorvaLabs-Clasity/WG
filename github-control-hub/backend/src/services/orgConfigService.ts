import { docClient, usesDynamo, tableName, PutCommand, GetCommand } from "../utils/dynamo";

export interface OrgFeatures {
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
  /**
   * The account self-hosted Renovate raises pull requests as.
   *
   * Configuration rather than a constant: there is no Renovate API to ask, so
   * authorship is the only marker, and every installation names its bot
   * differently. Unset means the organisation does not run Renovate, and the
   * tab says so instead of showing an empty table that looks like a failure.
   */
  renovateBot?: string;
}

const TABLE = () => tableName("ORG_CONFIG_TABLE");

// In-memory fallback for local development
let memConfig: OrgConfig = {
  org: process.env.GITHUB_ORG || "",
  features: {
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
      features: { rulesetsSupported: true, advancedSecurity: false },
    };
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: defaultConfig }));
    return defaultConfig;
  }
  return memConfig;
}

export async function updateRenovateBot(bot: string): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = { ...current, renovateBot: bot.trim() || undefined };
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memConfig = updated;
  }
  return updated;
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
