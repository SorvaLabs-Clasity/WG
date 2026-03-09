import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { listBranches, getProtection, listRulesets, getAllProtections } from "./branchService";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, QueryCommand, ScanCommand } from "../utils/dynamo";

export interface ScannerCondition {
  branchPatterns: string[];
  requiresProtection: boolean;
  protectionType: "any" | "classic" | "ruleset";
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
  targetRepos: "all" | string[];
  includeFutureRepos?: boolean;
}

export interface ComplianceViolation {
  repo: string;
  branch: string;
  reason: string;
}

export interface ScanResult {
  scannerId: string;
  runAt: string;
  totalScanned: number;
  compliantCount: number;
  nonCompliantCount: number;
  violations: ComplianceViolation[];
}

const TABLE = () => tableName("SCANNERS_TABLE");

// In-memory fallback for local development
const memScanners: Map<string, Scanner> = new Map();
const memScanResults: Map<string, ScanResult> = new Map();

export async function listScanners(): Promise<Scanner[]> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE(),
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "SCANNER" },
      })
    );
    return ((result.Items || []) as Scanner[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  return Array.from(memScanners.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getScanner(id: string): Promise<Scanner | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE(), Key: { pk: "SCANNER", sk: id } })
    );
    return result.Item as Scanner | undefined;
  }
  return memScanners.get(id);
}

export async function createScanner(data: Omit<Scanner, "id" | "createdAt" | "updatedAt">): Promise<Scanner> {
  const now = new Date().toISOString();
  const scanner: Scanner = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { pk: "SCANNER", sk: scanner.id, ...scanner },
      })
    );
  } else {
    memScanners.set(scanner.id, scanner);
  }

  return scanner;
}

export async function updateScanner(id: string, data: Partial<Omit<Scanner, "id" | "createdAt" | "updatedAt">>): Promise<Scanner | null> {
  const existing = await getScanner(id);
  if (!existing) return null;

  const updated: Scanner = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { pk: "SCANNER", sk: updated.id, ...updated },
      })
    );
  } else {
    memScanners.set(id, updated);
  }

  return updated;
}

export async function deleteScanner(id: string): Promise<boolean> {
  if (usesDynamo()) {
    const existing = await getScanner(id);
    if (!existing) return false;
    await docClient.send(
      new DeleteCommand({ TableName: TABLE(), Key: { pk: "SCANNER", sk: id } })
    );
    return true;
  }
  return memScanners.delete(id);
}

export async function getScanResult(scannerId: string): Promise<ScanResult | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(
      new GetCommand({ TableName: TABLE(), Key: { pk: "RESULT", sk: scannerId } })
    );
    return result.Item as ScanResult | undefined;
  }
  return memScanResults.get(scannerId);
}

function branchMatches(branch: string, pattern: string) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return branch.startsWith(pattern.slice(0, -1));
  }
  return branch === pattern;
}

export async function runScan(octokit: Octokit, scannerId: string, overrideReposToScan?: string[]): Promise<ScanResult> {
  const scanner = await getScanner(scannerId);
  if (!scanner) throw new Error("Scanner not found");

  const org = getOrg();
  let reposToScan: string[] = [];

  if (overrideReposToScan) {
    reposToScan = overrideReposToScan;
  } else if (scanner.targetRepos === "all") {
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.repos.listForOrg({
        org,
        type: "all",
        per_page: 100,
        page,
      });
      if (data.length === 0) break;
      reposToScan.push(...data.map((r: any) => r.name));
      if (data.length < 100) break;
      page++;
    }
  } else {
    reposToScan = [...scanner.targetRepos];
    if (scanner.includeFutureRepos) {
      const scannerCreatedAt = new Date(scanner.createdAt).getTime();
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.repos.listForOrg({
          org,
          type: "all",
          per_page: 100,
          page,
        });
        if (data.length === 0) break;
        
        for (const r of data) {
          if (r.created_at) {
            const repoCreatedAt = new Date(r.created_at).getTime();
            if (repoCreatedAt > scannerCreatedAt && !reposToScan.includes(r.name)) {
              reposToScan.push(r.name);
            }
          }
        }
        
        if (data.length < 100) break;
        page++;
      }
    }
  }

  const violations: ComplianceViolation[] = [];
  const compliantRepos = new Set<string>();
  const nonCompliantRepos = new Set<string>();

  for (const repo of reposToScan) {
    let isRepoCompliant = true;
    
    try {
      const branches = await listBranches(octokit, repo);
      const branchNames = branches.map(b => b.name);
      
      const classicProtections = await getAllProtections(octokit, repo);
      const rulesets = await listRulesets(octokit, repo);

      for (const condition of scanner.conditions) {
        for (const pattern of condition.branchPatterns) {
          const matchingBranches = branchNames.filter(b => branchMatches(b, pattern));
          
          if (matchingBranches.length === 0 && !pattern.includes("*")) {
            violations.push({ repo, branch: pattern, reason: "Required branch does not exist" });
            isRepoCompliant = false;
            continue;
          }

          for (const branch of matchingBranches) {
            let hasClassic = !!classicProtections[branch];
            
            const applyingRulesets = rulesets.filter((rs: any) => 
              rs.enforcement === "active" &&
              rs.conditions?.ref_name?.include?.some((inc: string) => branchMatches(branch, inc.replace('refs/heads/', '')))
            );
            
            let hasRuleset = applyingRulesets.length > 0;

            if (condition.requiresProtection) {
            if (!hasClassic && !hasRuleset) {
              violations.push({ repo, branch, reason: "Branch is not protected" });
              isRepoCompliant = false;
              continue;
            }

            if (condition.protectionType === "classic" && !hasClassic) {
              violations.push({ repo, branch, reason: "Branch lacks Classic protection (has Ruleset instead)" });
              isRepoCompliant = false;
              continue;
            }

            if (condition.protectionType === "ruleset" && !hasRuleset) {
              violations.push({ repo, branch, reason: "Branch lacks Repository Ruleset (has Classic instead)" });
              isRepoCompliant = false;
              continue;
            }

            if (condition.rules) {
              const ruleReqs = condition.rules;
              
              if (hasClassic) {
                const p = classicProtections[branch] as any;
                if (ruleReqs.requirePr && !p.required_pull_request_reviews) {
                  violations.push({ repo, branch, reason: "Classic protection missing PR requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.minApprovals && p.required_pull_request_reviews?.required_approving_review_count < ruleReqs.minApprovals) {
                  violations.push({ repo, branch, reason: `Classic protection requires ${p.required_pull_request_reviews?.required_approving_review_count} approvals, expected >= ${ruleReqs.minApprovals}` });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireStatusChecks && !p.required_status_checks) {
                  violations.push({ repo, branch, reason: "Classic protection missing status checks requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.dismissStaleReviews && p.required_pull_request_reviews && !p.required_pull_request_reviews.dismiss_stale_reviews) {
                  violations.push({ repo, branch, reason: "Classic protection missing dismiss stale reviews requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireCodeOwnerReviews && p.required_pull_request_reviews && !p.required_pull_request_reviews.require_code_owner_reviews) {
                  violations.push({ repo, branch, reason: "Classic protection missing code owner reviews requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireConversationResolution && !p.required_conversation_resolution?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing conversation resolution requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.strictStatusChecks && p.required_status_checks && !p.required_status_checks.strict) {
                  violations.push({ repo, branch, reason: "Classic protection missing strict status checks requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireSignedCommits && !p.required_signatures?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing signed commits requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireLinearHistory && !p.required_linear_history?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing linear history requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.enforceAdmins && !p.enforce_admins?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing enforce admins requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.preventForcePush && p.allow_force_pushes?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection allows force pushing" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.preventDeletion && p.allow_deletions?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection allows branch deletion" });
                  isRepoCompliant = false;
                }
              } else if (hasRuleset) {
                const allRules = applyingRulesets.flatMap((rs: any) => rs.rules || []);
                const hasRule = (type: string) => allRules.some((r: any) => r.type === type);
                const getRule = (type: string) => allRules.find((r: any) => r.type === type);

                if (ruleReqs.requirePr && !hasRule('pull_request')) {
                  violations.push({ repo, branch, reason: "Ruleset missing PR requirement" });
                  isRepoCompliant = false;
                }
                const prRule = getRule('pull_request');
                if (ruleReqs.minApprovals && prRule && (prRule.parameters?.required_approving_review_count || 0) < ruleReqs.minApprovals) {
                  violations.push({ repo, branch, reason: `Ruleset requires ${prRule.parameters?.required_approving_review_count || 0} approvals, expected >= ${ruleReqs.minApprovals}` });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireStatusChecks && !hasRule('required_status_checks')) {
                  violations.push({ repo, branch, reason: "Ruleset missing status checks requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.dismissStaleReviews && prRule && !prRule.parameters?.dismiss_stale_reviews_on_push) {
                  violations.push({ repo, branch, reason: "Ruleset missing dismiss stale reviews requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireCodeOwnerReviews && prRule && !prRule.parameters?.require_code_owner_review) {
                  violations.push({ repo, branch, reason: "Ruleset missing code owner reviews requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireConversationResolution && prRule && !prRule.parameters?.required_review_thread_resolution) {
                  violations.push({ repo, branch, reason: "Ruleset missing conversation resolution requirement" });
                  isRepoCompliant = false;
                }
                const statusRule = getRule('required_status_checks');
                if (ruleReqs.strictStatusChecks && statusRule && !statusRule.parameters?.strict_required_status_checks_policy) {
                  violations.push({ repo, branch, reason: "Ruleset missing strict status checks requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireSignedCommits && !hasRule('required_signatures')) {
                  violations.push({ repo, branch, reason: "Ruleset missing signed commits requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.requireLinearHistory && !hasRule('required_linear_history')) {
                  violations.push({ repo, branch, reason: "Ruleset missing linear history requirement" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.preventForcePush && !hasRule('non_fast_forward')) {
                  violations.push({ repo, branch, reason: "Ruleset allows force pushing" });
                  isRepoCompliant = false;
                }
                if (ruleReqs.preventDeletion && !hasRule('deletion')) {
                  violations.push({ repo, branch, reason: "Ruleset allows branch deletion" });
                  isRepoCompliant = false;
                }
                const isEnforcedForAdmins = applyingRulesets.some((rs: any) => !rs.bypass_actors || rs.bypass_actors.length === 0);
                if (ruleReqs.enforceAdmins && !isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset missing enforce admins requirement (allows bypass)" });
                  isRepoCompliant = false;
                }
              }
            }
          } else {
              if (hasClassic || hasRuleset) {
                violations.push({ repo, branch, reason: "Branch is protected but should not be" });
                isRepoCompliant = false;
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`Error scanning repo ${repo}:`, err);
      violations.push({ repo, branch: "*", reason: `Failed to scan repository: ${(err as Error).message}` });
      isRepoCompliant = false;
    }

    if (isRepoCompliant) {
      compliantRepos.add(repo);
    } else {
      nonCompliantRepos.add(repo);
    }
  }

  const result: ScanResult = {
    scannerId,
    runAt: new Date().toISOString(),
    totalScanned: reposToScan.length,
    compliantCount: compliantRepos.size,
    nonCompliantCount: nonCompliantRepos.size,
    violations,
  };

  if (usesDynamo()) {
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { pk: "RESULT", sk: scannerId, ...result },
      })
    );
    // Update scanner lastRunAt
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { pk: "SCANNER", sk: scannerId, ...scanner, lastRunAt: result.runAt, updatedAt: new Date().toISOString() },
      })
    );
  } else {
    memScanResults.set(scannerId, result);
    scanner.lastRunAt = result.runAt;
    memScanners.set(scannerId, scanner);
  }

  return result;
}

// Seed a default scanner for local dev (runs only in non-production)
if (!usesDynamo()) {
  createScanner({
    name: "Standard Org Compliance",
    description: "Ensures main and uat branches exist and are protected via Rulesets with PRs required.",
    targetRepos: "all",
    includeFutureRepos: true,
    conditions: [
      {
        branchPatterns: ["main"],
        requiresProtection: true,
        protectionType: "ruleset",
        rules: { requirePr: true, minApprovals: 2, requireStatusChecks: true, enforceAdmins: true }
      },
      {
        branchPatterns: ["uat"],
        requiresProtection: true,
        protectionType: "ruleset",
        rules: { requirePr: true, minApprovals: 1, preventForcePush: true, preventDeletion: true }
      }
    ]
  });
}
