import { Octokit } from "octokit";
import { getOrg } from "../github/client";

export interface RepoComplianceScore {
  repo: string;
  score: number;
  protectionsActive: boolean;
  rulesetsActive: boolean;
  hasRequiredFiles: boolean;
  outsideCollaborators: number;
  issues: string[];
  lastChecked: string;
}

/**
 * For a real implementation, we'd hit the GitHub API to check:
 * - Outside collaborators: GET /repos/{owner}/{repo}/collaborators?affiliation=outside
 * - Required files: GET /repos/{owner}/{repo}/contents/README.md
 * - Protections: GET /repos/{owner}/{repo}/branches/main/protection
 * 
 * Here we provide a mock/hybrid implementation.
 */
export async function calculateRepoCompliance(octokit: Octokit, repoName: string): Promise<RepoComplianceScore> {
  const org = getOrg();
  const issues: string[] = [];
  let score = 100;
  
  let protectionsActive = true;
  let rulesetsActive = true;
  let hasRequiredFiles = true;
  let outsideCollaborators = 0;

  try {
    // 1. Check for protections/rulesets (mocked for simplicity here, but would use branchService)
    // In a real app we would call listRulesets() and getProtection() from branchService
    
    // 2. Check required files (e.g. README.md)
    try {
      await octokit.rest.repos.getContent({
        owner: org,
        repo: repoName,
        path: "README.md",
      });
    } catch (e: any) {
      if (e.status === 404) {
        hasRequiredFiles = false;
        issues.push("Missing README.md");
        score -= 20;
      }
    }

    // 3. Check outside collaborators (requires admin access, might return 403)
    try {
      const { data: collabs } = await octokit.rest.repos.listCollaborators({
        owner: org,
        repo: repoName,
        affiliation: "outside",
      });
      outsideCollaborators = collabs.length;
      if (outsideCollaborators > 0) {
        issues.push(`${outsideCollaborators} outside collaborator(s) have access`);
        score -= (10 * outsideCollaborators);
      }
    } catch (e: any) {
      // If we don't have permission to check, just assume 0 for demo purposes, 
      // or record it as a warning.
    }

  } catch (error) {
    console.error(`Error calculating compliance for ${repoName}:`, error);
    issues.push("Failed to check repository compliance completely.");
  }

  // Ensure score is within bounds
  score = Math.max(0, Math.min(100, score));

  return {
    repo: repoName,
    score,
    protectionsActive,
    rulesetsActive,
    hasRequiredFiles,
    outsideCollaborators,
    issues,
    lastChecked: new Date().toISOString(),
  };
}
