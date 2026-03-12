export type OnBaseBranchMissing = "skip_rule" | "use_default" | "undo_repo";

export interface BranchRule {
  branchNames: string[];
  baseBranchMode?: "default" | "specific";
  baseBranch?: string;
  onBaseBranchMissing?: OnBaseBranchMissing;
  protection: {
    type: "classic" | "ruleset" | "ruleset_json";
    rawJson?: any;
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

    requireCodeQuality?: boolean;
    codeQualitySeverity?: string;

    copilotCodeReview?: boolean;
    copilotReviewOnPush?: boolean;
    copilotReviewDraftPrs?: boolean;

    // Ruleset bypass actors
    bypassActors?: Array<{
      actor_id: number;
      actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
      bypass_mode: "always" | "pull_request";
    }>;

    // Classic push restrictions
    restrictPushes?: boolean;
    restrictMatchingBranchCreation?: boolean;
    pushRestrictionUsers?: string[];
    pushRestrictionTeams?: string[];
    pushRestrictionApps?: string[];
  } | null;
}

export interface RepoTemplate {
  id: string;
  name: string;
  description: string;
  branches: BranchRule[];
  autoApplyOnNewRepo: boolean;
  exclusionLists?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExclusionList {
  id: string;
  name: string;
  description: string;
  repos: string[];
  forceTemplateIds: string[];
  forceOnNewTemplates: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
