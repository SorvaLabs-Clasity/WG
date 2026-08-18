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
   * differently. Unset means the organization does not run Renovate, and the
   * tab says so instead of showing an empty table that looks like a failure.
   */
  renovateBot?: string;
  /**
   * When the access graph was last rebuilt, and how it went.
   *
   * Kept here rather than beside the edges because the aggregator clears that
   * table before rewriting it — a marker stored there would be deleted by the
   * next run, including a run that then failed, leaving no record at all.
   *
   * The screens that read the graph are showing a snapshot. Without this they
   * had no way to say how old it was, so a graph last built before someone
   * joined, left, or was made an owner looked exactly like a current one.
   */
  graphAggregation?: {
    /** Completion of the last run that actually wrote edges. */
    lastSuccessAt?: string;
    /** Start of the last run, successful or not. */
    lastAttemptAt?: string;
    /** Set when the last attempt failed, so the UI can say so rather than just looking stale. */
    lastError?: string;
    edgeCount?: number;
  };
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

/**
 * Records how the access graph rebuild went.
 *
 * Merged onto whatever is stored rather than replacing it, so recording a
 * failed attempt does not erase the timestamp of the last good one — "last
 * built four hours ago, last attempt failed ten minutes ago" is the state
 * somebody needs to see, and either field alone hides half of it.
 */
export async function recordGraphAggregation(
  update: Partial<NonNullable<OrgConfig["graphAggregation"]>>,
): Promise<OrgConfig> {
  const current = await getOrgConfig();
  const updated: OrgConfig = {
    ...current,
    graphAggregation: { ...current.graphAggregation, ...update },
  };
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
