export interface BranchRule {
  branchNames: string[];
  protection: {
    type: "classic" | "ruleset";
    rulesetName?: string;
    enforcement?: "active" | "evaluate" | "disabled";

    // Restrict operations (ruleset only)
    restrictCreations?: boolean;
    restrictUpdates?: boolean;

    requirePr: boolean;
    requiredApprovals: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requireLastPushApproval?: boolean;
    requireConversationResolution: boolean;
    allowedMergeMethods?: string[];

    requireStatusChecks: boolean;
    strictStatusChecks: boolean;
    doNotRequireStatusChecksOnCreation?: boolean;
    statusCheckContexts?: string[];

    requireDeployments?: boolean;
    requiredDeploymentEnvironments?: string[];

    requireSignedCommits: boolean;
    requireLinearHistory: boolean;
    enforceAdmins: boolean;
    preventForcePush: boolean;
    preventDeletion: boolean;

    requireCodeScanning?: boolean;
    codeScanningTool?: string;
    codeScanningAlertsThreshold?: string;
    codeScanningSecurityAlertsThreshold?: string;
  } | null;
}

export interface RepoTemplate {
  id: string;
  name: string;
  description: string;
  branches: BranchRule[];
  autoApplyOnNewRepo: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
