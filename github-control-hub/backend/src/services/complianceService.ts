import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { getAllProtections, listRulesets } from "./branchService";
import { getComplianceConfig, ComplianceRule } from "./complianceConfigService";
import { evaluateSecurityQuery } from "./graphService";

export interface RuleResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  detail?: string;
}

export interface RepoComplianceScore {
  repo: string;
  score: number;
  protectionsActive: boolean;
  rulesetsActive: boolean;
  hasRequiredFiles: boolean;
  outsideCollaborators: number;
  issues: string[];
  lastChecked: string;
  ruleResults: RuleResult[];
}

export async function calculateRepoCompliance(
  octokit: Octokit,
  repoName: string,
  userToken?: string
): Promise<RepoComplianceScore> {
  const org = getOrg();
  const config = await getComplianceConfig();
  const enabledRules = config.rules.filter((r) => r.enabled);

  const issues: string[] = [];
  const ruleResults: RuleResult[] = [];
  let score = 100;

  let protectionsActive = false;
  let rulesetsActive = false;
  let hasRequiredFiles = true;
  let outsideCollaborators = 0;

  let defaultBranch: string | null = null;
  const needsDefault = enabledRules.some(
    (r) => r.type === "branch_protection" && (r.branchName || "").includes("__default__")
  );
  if (needsDefault) {
    try {
      const { data: repoData } = await octokit.rest.repos.get({ owner: org, repo: repoName });
      defaultBranch = repoData.default_branch;
    } catch {
      defaultBranch = "main";
    }
  }

  for (const rule of enabledRules) {
    try {
      const result = await evaluateRule(octokit, org, repoName, rule, defaultBranch, userToken);
      ruleResults.push({ ruleId: rule.id, ruleName: rule.name, passed: result.passed, detail: result.detail });
      if (!result.passed) {
        score -= rule.weight;
        issues.push(result.detail || rule.name);
      }
      if (rule.type === "branch_protection") protectionsActive = protectionsActive || result.passed;
      if (rule.type === "rulesets") rulesetsActive = result.passed;
      if (rule.type === "required_files") hasRequiredFiles = hasRequiredFiles && result.passed;
      if (rule.type === "outside_collaborators" && result.collabCount !== undefined) {
        outsideCollaborators = result.collabCount;
      }
    } catch (error) {
      console.error(`Error evaluating rule '${rule.name}' for ${repoName}:`, error);
      ruleResults.push({ ruleId: rule.id, ruleName: rule.name, passed: false, detail: `Error checking: ${rule.name}` });
      score -= rule.weight;
      issues.push(`Could not check: ${rule.name}`);
    }
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
    ruleResults,
  };
}

interface RuleEvalResult {
  passed: boolean;
  detail?: string;
  collabCount?: number;
}

async function evaluateRule(
  octokit: Octokit,
  org: string,
  repo: string,
  rule: ComplianceRule,
  defaultBranch: string | null,
  userToken?: string
): Promise<RuleEvalResult> {
  switch (rule.type) {
    case "branch_protection":
      return evaluateBranchProtection(octokit, org, repo, rule, defaultBranch);
    case "rulesets":
      return evaluateRulesets(octokit, repo);
    case "required_files":
      return evaluateRequiredFiles(octokit, org, repo, rule);
    case "outside_collaborators":
      return evaluateOutsideCollaborators(octokit, org, repo, rule);
    case "query":
      return evaluateQueryRule(rule, repo, userToken);
    default:
      return { passed: true };
  }
}

async function evaluateBranchProtection(
  octokit: Octokit,
  org: string,
  repo: string,
  rule: ComplianceRule,
  defaultBranch: string | null
): Promise<RuleEvalResult> {
  const branchList = (rule.branchName || "__default__").split(",").map(b => b.trim()).filter(Boolean);
  const targetBranches = [...new Set(branchList.map(b => b === "__default__" ? (defaultBranch || "main") : b))];
  const wantType = rule.protectionType || "any";

  const allFailures: string[] = [];
  
  let protections: any = null;
  let rulesets: any = null;

  try {
    protections = await getAllProtections(octokit, repo);
  } catch { /* ignore */ }

  try {
    rulesets = await listRulesets(octokit, repo);
  } catch { /* ignore */ }

  for (const branch of targetBranches) {
    let hasClassic = false;
    let hasRuleset = false;
    let classicData: any = null;
    let rulesetRules: any[] = [];

    if (protections && protections[branch]) {
      hasClassic = true;
      classicData = protections[branch];
    }

    if (rulesets) {
      for (const rs of rulesets as any[]) {
        if (rs.enforcement !== "active" || rs.target !== "branch") continue;
        try {
          const { data: details } = await octokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
            owner: org, repo, ruleset_id: rs.id,
          });
          const refs = details.conditions?.ref_name?.include || [];
          const applies = refs.includes(`refs/heads/${branch}`) ||
            refs.some((r: string) => r.includes(branch)) ||
            (refs.includes("~DEFAULT_BRANCH") && branch === defaultBranch);
          if (applies) {
            hasRuleset = true;
            rulesetRules = rulesetRules.concat(details.rules || []);
          }
        } catch { /* skip */ }
      }
    }

    let typeMatch = false;
    if (wantType === "classic" && hasClassic) typeMatch = true;
    else if (wantType === "ruleset" && hasRuleset) typeMatch = true;
    else if (wantType === "any" && (hasClassic || hasRuleset)) typeMatch = true;

    if (!typeMatch) {
      allFailures.push(`Branch '${branch}' lacks ${wantType === "any" ? "any" : wantType} protection`);
      continue;
    }

    if (rule.rules) {
      const failures: string[] = [];

      if (rule.rules.requirePr) {
        const prOk = (classicData?.required_pull_request_reviews) ||
          rulesetRules.some((r: any) => r.type === "pull_request");
        if (!prOk) failures.push("Require PRs");
      }
      if (rule.rules.minApprovals && rule.rules.minApprovals > 0) {
        const classicApprovals = classicData?.required_pull_request_reviews?.required_approving_review_count || 0;
        const rulesetApprovals = rulesetRules
          .filter((r: any) => r.type === "pull_request")
          .reduce((max: number, r: any) => Math.max(max, r.parameters?.required_approving_review_count || 0), 0);
        if (Math.max(classicApprovals, rulesetApprovals) < rule.rules.minApprovals) {
          failures.push(`Min ${rule.rules.minApprovals} approvals`);
        }
      }
      if (rule.rules.dismissStaleReviews) {
        const ok = classicData?.required_pull_request_reviews?.dismiss_stale_reviews === true;
        if (!ok) failures.push("Dismiss stale reviews");
      }
      if (rule.rules.requireCodeOwnerReviews) {
        const ok = classicData?.required_pull_request_reviews?.require_code_owner_reviews === true;
        if (!ok) failures.push("Require code owner reviews");
      }
      if (rule.rules.requireConversationResolution) {
        const ok = classicData?.required_conversation_resolution?.enabled === true;
        if (!ok) failures.push("Require conversation resolution");
      }
      if (rule.rules.requireStatusChecks) {
        const ok = !!classicData?.required_status_checks ||
          rulesetRules.some((r: any) => r.type === "required_status_checks");
        if (!ok) failures.push("Require status checks");
      }
      if (rule.rules.strictStatusChecks) {
        const ok = classicData?.required_status_checks?.strict === true;
        if (!ok) failures.push("Strict status checks");
      }
      if (rule.rules.requireSignedCommits) {
        const ok = classicData?.required_signatures?.enabled === true ||
          rulesetRules.some((r: any) => r.type === "required_signatures");
        if (!ok) failures.push("Require signed commits");
      }
      if (rule.rules.requireLinearHistory) {
        const ok = classicData?.required_linear_history?.enabled === true ||
          rulesetRules.some((r: any) => r.type === "required_linear_history");
        if (!ok) failures.push("Require linear history");
      }
      if (rule.rules.enforceAdmins) {
        const ok = classicData?.enforce_admins?.enabled === true;
        if (!ok) failures.push("Enforce for admins");
      }
      if (rule.rules.preventForcePush) {
        const ok = classicData?.allow_force_pushes?.enabled === false ||
          (classicData && classicData.allow_force_pushes === undefined) ||
          rulesetRules.some((r: any) => r.type === "non_fast_forward");
        if (!ok) failures.push("Prevent force push");
      }
      if (rule.rules.preventDeletion) {
        const ok = classicData?.allow_deletions?.enabled === false ||
          (classicData && classicData.allow_deletions === undefined) ||
          rulesetRules.some((r: any) => r.type === "deletion");
        if (!ok) failures.push("Prevent deletion");
      }

      if (failures.length > 0) {
        allFailures.push(`Branch '${branch}' missing: ${failures.join(", ")}`);
      }
    }
  }

  if (allFailures.length > 0) {
    return { passed: false, detail: allFailures.join(" | ") };
  }
  return { passed: true };
}

async function evaluateRulesets(octokit: Octokit, repo: string): Promise<RuleEvalResult> {
  const rulesets = await listRulesets(octokit, repo);
  const active = (rulesets as any[]).filter((rs: any) => rs.enforcement === "active");
  if (active.length > 0) return { passed: true };
  return { passed: false, detail: "No active repository rulesets" };
}

async function evaluateRequiredFiles(
  octokit: Octokit,
  org: string,
  repo: string,
  rule: ComplianceRule
): Promise<RuleEvalResult> {
  const files = rule.requiredFiles || ["README.md"];
  const missing: string[] = [];

  for (const file of files) {
    try {
      await octokit.rest.repos.getContent({ owner: org, repo, path: file });
    } catch (e: any) {
      if (e.status === 404) missing.push(file);
    }
  }

  if (missing.length > 0) {
    return { passed: false, detail: `Missing files: ${missing.join(", ")}` };
  }
  return { passed: true };
}

async function evaluateOutsideCollaborators(
  octokit: Octokit,
  org: string,
  repo: string,
  rule: ComplianceRule
): Promise<RuleEvalResult> {
  const maxAllowed = rule.maxOutsideCollaborators ?? 0;

  try {
    const { data: collabs } = await octokit.rest.repos.listCollaborators({
      owner: org,
      repo,
      affiliation: "outside",
    });
    const count = collabs.length;
    if (count > maxAllowed) {
      return {
        passed: false,
        detail: `${count} outside collaborator(s) (max ${maxAllowed})`,
        collabCount: count,
      };
    }
    return { passed: true, collabCount: count };
  } catch {
    return { passed: true, collabCount: 0 };
  }
}

async function evaluateQueryRule(
  rule: ComplianceRule,
  repo: string,
  userToken?: string
): Promise<RuleEvalResult> {
  if (!rule.queryId) return { passed: true };

  try {
    const results = await evaluateSecurityQuery(
      rule.queryId,
      rule.queryParam,
      rule.queryAdvanced,
      userToken
    );
    const repoMatched = results.some((r: any) => r.repo === repo);
    return {
      passed: !repoMatched,
      detail: repoMatched ? `Matched query: ${rule.name}` : undefined,
    };
  } catch {
    return { passed: true, detail: "Could not evaluate query" };
  }
}
