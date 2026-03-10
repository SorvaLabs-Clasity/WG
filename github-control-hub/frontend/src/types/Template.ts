export interface BranchRule {
  branchNames: string[];
  protection: {
    type: "classic" | "ruleset";
    rulesetName?: string;
    requirePr: boolean;
    requiredApprovals: number;
    dismissStaleReviews: boolean;
    requireCodeOwnerReviews: boolean;
    requireConversationResolution: boolean;
    requireStatusChecks: boolean;
    strictStatusChecks: boolean; // require branches to be up to date before merging
    requireSignedCommits: boolean;
    requireLinearHistory: boolean;
    enforceAdmins: boolean;
    preventForcePush: boolean;
    preventDeletion: boolean;
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
