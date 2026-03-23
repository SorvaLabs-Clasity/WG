export type OnBaseBranchMissing = "skip_rule" | "use_default" | "undo_repo";

export interface BranchRule {
  branchNames: string[];
  /** When true (default), create branches that don't exist. When false, only apply protection to branches that already exist. */
  createBranchesIfMissing?: boolean;
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

export interface TagRule {
  tagPatterns: string[];
  rulesetName?: string;
  enforcement?: "active" | "evaluate" | "disabled";
  preventCreation?: boolean;
  preventUpdate?: boolean;
  preventDeletion?: boolean;
  preventForcePush?: boolean;
  requireSignedCommits?: boolean;
  rawJson?: any;
  namePattern?: {
    operator: "starts_with" | "ends_with" | "contains" | "regex";
    pattern: string;
    negate?: boolean;
    name?: string;
  };
  bypassActors?: Array<{
    actor_id: number;
    actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
    bypass_mode: "always" | "pull_request";
  }>;
}

export interface PushRule {
  rulesetName?: string;
  enforcement?: "active" | "evaluate" | "disabled";
  filePathRestriction?: {
    restrictedFilePaths: string[];
  };
  maxFilePathLength?: number;
  maxFileSize?: number;
  fileExtensionRestriction?: {
    restrictedFileExtensions: string[];
  };
  rawJson?: any;
  bypassActors?: Array<{
    actor_id: number;
    actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
    bypass_mode: "always" | "pull_request";
  }>;
}

export interface RepoTemplate {
  id: string;
  name: string;
  description: string;
  branches: BranchRule[];
  tags?: TagRule[];
  pushRules?: PushRule[];
  autoApplyOnNewRepo: boolean;
  exclusionLists?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ExclusionPatternType = "starts_with" | "contains" | "created_by" | "has_codeowners_entry";

export interface ExclusionPattern {
  id: string;
  type: ExclusionPatternType;
  value: string;
}

export interface ExclusionList {
  id: string;
  name: string;
  description: string;
  repos: string[];
  patterns: ExclusionPattern[];
  patternWhitelist: string[];
  forceTemplateIds: string[];
  forceOnNewTemplates: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
