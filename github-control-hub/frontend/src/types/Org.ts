export interface OrgFeatures {
  auditLogs: boolean;
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
}
