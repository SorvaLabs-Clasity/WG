import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { getAllProtections, listRulesets } from "./branchService";

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

export async function calculateRepoCompliance(octokit: Octokit, repoName: string): Promise<RepoComplianceScore> {
  const org = getOrg();
  const issues: string[] = [];
  let score = 100;
  
  let protectionsActive = false;
  let rulesetsActive = false;
  let hasRequiredFiles = true;
  let outsideCollaborators = 0;

  try {
    // 1. Check classic branch protections on default branch
    try {
      const { data: repoData } = await octokit.rest.repos.get({ owner: org, repo: repoName });
      const defaultBranch = repoData.default_branch;

      const protections = await getAllProtections(octokit, repoName);
      protectionsActive = !!protections[defaultBranch];

      if (!protectionsActive) {
        issues.push(`Default branch '${defaultBranch}' has no classic branch protection`);
        score -= 25;
      }
    } catch (e: any) {
      issues.push("Could not check branch protections");
      score -= 25;
    }

    // 2. Check repository rulesets
    try {
      const rulesets = await listRulesets(octokit, repoName);
      const activeRulesets = (rulesets as any[]).filter((rs: any) => rs.enforcement === "active");
      rulesetsActive = activeRulesets.length > 0;

      if (!rulesetsActive) {
        issues.push("No active repository rulesets");
        score -= 15;
      }
    } catch (e: any) {
      issues.push("Could not check rulesets");
      score -= 15;
    }

    // 3. Check required files (README.md)
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

    // 4. Check outside collaborators
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
    } catch {
      // If we don't have permission, skip silently
    }

  } catch (error) {
    console.error(`Error calculating compliance for ${repoName}:`, error);
    issues.push("Failed to check repository compliance completely.");
  }

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
