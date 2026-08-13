/**
 * The shapes of a protection rule, as the Protect* modals build them and the
 * branches API sends them.
 *
 * These used to live in types/Template.ts because templates were the thing that
 * carried them around. Templates are gone; protecting a branch, a tag or a push
 * by hand is not, and these are its vocabulary.
 */

export interface BranchProtection {
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
