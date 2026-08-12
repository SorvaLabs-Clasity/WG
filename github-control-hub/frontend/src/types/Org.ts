export interface OrgFeatures {
  rulesetsSupported: boolean;
  advancedSecurity: boolean;
}

export interface OrgConfig {
  org: string;
  features: OrgFeatures;
}
