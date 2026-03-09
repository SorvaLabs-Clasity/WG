export interface OrgFeatures {
  auditLogs: boolean;
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
}

// In-memory store for local development.
// In production, this would be stored in DynamoDB or Systems Manager Parameter Store.
let config: OrgConfig = {
  org: process.env.GITHUB_ORG || "default-org",
  features: {
    auditLogs: false,
    rulesetsSupported: true, // Assuming true by default for modern orgs
    advancedSecurity: false,
  }
};

export function getOrgConfig(): OrgConfig {
  return config;
}

export function updateOrgFeatures(featureUpdates: Partial<OrgFeatures>): OrgConfig {
  config = {
    ...config,
    features: {
      ...config.features,
      ...featureUpdates
    }
  };
  return config;
}
