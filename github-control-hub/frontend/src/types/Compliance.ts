export interface RepoComplianceScore {
  repo: string;
  score: number; // 0 to 100
  protectionsActive: boolean;
  rulesetsActive: boolean;
  hasRequiredFiles: boolean;
  outsideCollaborators: number;
  issues: string[];
  lastChecked: string;
  ruleResults?: { ruleId: string; ruleName: string; passed: boolean; detail?: string }[];
}

export interface ComplianceRule {
  id: string;
  name: string;
  enabled: boolean;
  weight: number;
  type: "branch_protection" | "rulesets" | "required_files" | "outside_collaborators" | "query";
  // branch_protection
  branchName?: string;
  protectionType?: "any" | "classic" | "ruleset";
  rules?: {
    requirePr?: boolean;
    minApprovals?: number;
    dismissStaleReviews?: boolean;
    requireCodeOwnerReviews?: boolean;
    requireConversationResolution?: boolean;
    requireStatusChecks?: boolean;
    strictStatusChecks?: boolean;
    requireSignedCommits?: boolean;
    requireLinearHistory?: boolean;
    enforceAdmins?: boolean;
    preventForcePush?: boolean;
    preventDeletion?: boolean;
  };
  // required_files
  requiredFiles?: string[];
  // outside_collaborators
  maxOutsideCollaborators?: number;
  // query
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: Record<string, unknown>;
}

export interface ComplianceConfig {
  rules: ComplianceRule[];
}
