export interface RepoComplianceScore {
  repo: string;
  score: number; // 0 to 100
  protectionsActive: boolean;
  rulesetsActive: boolean;
  hasRequiredFiles: boolean; // e.g. README.md, CODEOWNERS
  outsideCollaborators: number; // Count of outside collaborators
  issues: string[]; // List of specific issues found
  lastChecked: string;
}
