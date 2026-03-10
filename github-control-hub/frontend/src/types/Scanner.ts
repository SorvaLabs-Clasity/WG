export interface ScannerCondition {
  branchPatterns: string[]; // Use an array for tag-style inputs like in templates
  requiresProtection: boolean;
  protectionType: "any" | "classic" | "ruleset";
  ruleMatchType?: "any" | "at_least" | "exact";
  // Granular rules to check for (if requiresProtection is true)
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
}

export interface Scanner {
  id: string;
  name: string;
  description: string;
  conditions: ScannerCondition[];
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  targetRepos: "all" | string[]; // "all" or array of repo names
  includeFutureRepos?: boolean;
}

export interface ComplianceViolation {
  repo: string;
  branch: string;
  reason: string; // e.g., "Missing branch 'main'", "Protection type is 'classic', expected 'ruleset'", "Requires 2 approvals, found 1"
}

export interface ScanResult {
  scannerId: string;
  runAt: string;
  totalScanned: number;
  compliantCount: number;
  nonCompliantCount: number;
  violations: ComplianceViolation[];
}
