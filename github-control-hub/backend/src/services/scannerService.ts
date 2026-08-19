import crypto from "crypto";
import { Octokit } from "octokit";
import { getOrg } from "../github/client";
import { listBranches, getProtection, listRulesets, getAllProtections } from "./branchService";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, QueryCommand, ScanCommand } from "../utils/dynamo";
import { logActivity } from "./activityService";

export interface ScannerCondition {
  type?: "branch_protection" | "query";
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: any;

  branchPatterns?: string[];
  requiresProtection?: boolean;
  protectionType?: "any" | "classic" | "ruleset";
  ruleMatchType?: "any" | "at_least" | "exact";
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
  /**
   * Repositories this result actually covers.
   *
   * Needed because a run is not always a full one: the webhook path re-scans
   * the single repository an event touched, and without knowing what a stored
   * result covers there is no way to fold that in. Absent on rows written
   * before this existed, which mergeScanResult handles.
   */
  scannedRepos?: string[];
  /** When a scoped re-scan last updated part of this result. */
  partialUpdatedAt?: string;
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

export async function createScanner(data: Omit<Scanner, "id" | "createdAt" | "updatedAt">, actor?: string): Promise<Scanner> {
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

  if (actor) {
    await logActivity("scanner.create", actor, "*", scanner.name, `Created scanner "${scanner.name}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "delete_scanner", params: { scannerId: scanner.id, scannerData: scanner } } }
    );
  }
  return scanner;
}

export async function updateScanner(id: string, data: Partial<Omit<Scanner, "id" | "createdAt" | "updatedAt">>, actor?: string): Promise<Scanner | null> {
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

  if (actor) {
    await logActivity("scanner.update", actor, "*", updated.name, `Updated scanner "${updated.name}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "revert_scanner", params: { scannerId: id, previousState: existing, currentState: updated } } }
    );
  }
  return updated;
}

export async function putScannerRaw(scanner: Scanner): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: { pk: "SCANNER", sk: scanner.id, ...scanner } }));
  } else {
    memScanners.set(scanner.id, scanner);
  }
}

export async function deleteScannerRaw(id: string): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: "SCANNER", sk: id } }));
  } else {
    memScanners.delete(id);
  }
}

export async function deleteScanner(id: string, actor?: string): Promise<boolean> {
  const existing = await getScanner(id);
  if (!existing) return false;
  if (usesDynamo()) {
    await docClient.send(
      new DeleteCommand({ TableName: TABLE(), Key: { pk: "SCANNER", sk: id } })
    );
  } else {
    memScanners.delete(id);
  }

  if (actor) {
    await logActivity("scanner.delete", actor, "*", existing.name, `Deleted scanner "${existing.name}"`,
      undefined, "app", undefined, undefined,
      { undoPayload: { action: "restore_scanner", params: { scannerData: existing } } }
    );
  }
  return true;
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

/**
 * A query condition's violation, which is about an entity rather than a branch.
 *
 * Queries are evaluated across the whole organization on every run, scoped or
 * not, so their rows are always replaced wholesale rather than merged.
 */
const isQueryRow = (v: ComplianceViolation) => v.branch === "-";

/**
 * Fold a scoped re-scan into the stored org-wide result.
 *
 * The webhook path calls runScan with a single repository — the one an event
 * touched — and the result used to be written straight over the stored row.
 * So one push replaced "347 scanned, 42 in violation" with "1 scanned, 0 in
 * violation", and every finding for the other 346 repositories vanished from
 * the page until somebody pressed Run again. A compliance screen that reports
 * fewer violations than exist, and reports them because something *worked*, is
 * the worst way for this to fail.
 *
 * Merging instead: the re-scanned repositories' rows are replaced, everything
 * else is kept, and the counts are derived from the union.
 */
export function mergeScanResult(
  previous: ScanResult,
  fresh: ScanResult,
  scanned: string[],
): ScanResult {
  const scannedSet = new Set(scanned);

  const kept = previous.violations.filter(v => !scannedSet.has(v.repo) && !isQueryRow(v));
  const violations = [...kept, ...fresh.violations];

  // An older row carries no scannedRepos. Its totalScanned is the only record
  // of how wide it was, so the coverage never shrinks below it.
  const coverage = new Set([...(previous.scannedRepos ?? []), ...scanned]);
  const totalScanned = Math.max(previous.totalScanned, coverage.size);

  const nonCompliant = new Set(violations.map(v => v.repo));

  return {
    scannerId: previous.scannerId,
    // The full run's time, not this one's: the result still describes what that
    // run found for everything outside the re-scanned set.
    runAt: previous.runAt,
    partialUpdatedAt: fresh.runAt,
    totalScanned,
    nonCompliantCount: nonCompliant.size,
    compliantCount: Math.max(0, totalScanned - nonCompliant.size),
    violations,
    scannedRepos: [...coverage],
  };
}

export async function runScan(octokit: Octokit, scannerId: string, overrideReposToScan?: string[], token?: string): Promise<ScanResult> {
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

  const { evaluateSecurityQuery } = await import("./graphService");

  // 1. Evaluate "query" conditions
  const queryConditions = scanner.conditions.filter(c => c.type === "query");
  for (const condition of queryConditions) {
    if (condition.queryId) {
      try {
        const results = await evaluateSecurityQuery(
          condition.queryId,
          condition.queryParam,
          condition.queryAdvanced,
          token
        );

        for (const res of results) {
          const entity = res.repo || res.user || res.team || "unknown";
          // If scanner is restricted to specific repos, filter out entities that are repos but not in target list
          if (scanner.targetRepos !== "all" && res.repo && !reposToScan.includes(res.repo)) {
            continue;
          }
          
          violations.push({
            repo: entity,
            branch: "-", // N/A for queries
            reason: res.reason || "Matched security query"
          });
          
          if (res.repo) {
            nonCompliantRepos.add(res.repo);
          }
        }
      } catch (err: any) {
        console.error("Error evaluating query scanner:", err);
      }
    }
  }

  // 2. Evaluate branch protection conditions
  const branchConditions = scanner.conditions.filter(c => !c.type || c.type === "branch_protection");

  for (const repo of reposToScan) {
    let isRepoCompliant = !nonCompliantRepos.has(repo);
    
    try {
      if (branchConditions.length > 0) {
        const branches = await listBranches(octokit, repo);
        const branchNames = branches.map(b => b.name);
        
        const classicProtections = await getAllProtections(octokit, repo);
        const rulesets = await listRulesets(octokit, repo);

        for (const condition of branchConditions) {
          if (!condition.branchPatterns) continue;
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

            if (condition.rules && condition.ruleMatchType !== "any") {
              const ruleReqs = condition.rules;
              const isExact = condition.ruleMatchType === "exact";
              
              if (hasClassic) {
                const p = classicProtections[branch] as any;
                const hasPr = !!p.required_pull_request_reviews;
                const hasStatusChecks = !!p.required_status_checks;
                const hasSignedCommits = !!p.required_signatures?.enabled;
                const hasLinearHistory = !!p.required_linear_history?.enabled;
                const hasEnforceAdmins = !!p.enforce_admins?.enabled;
                const preventsForcePush = !p.allow_force_pushes?.enabled;
                const preventsDeletion = !p.allow_deletions?.enabled;

                if (ruleReqs.requirePr && !hasPr) {
                  violations.push({ repo, branch, reason: "Classic protection missing PR requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requirePr && hasPr) {
                  violations.push({ repo, branch, reason: "Classic protection has PR requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasPr) {
                  if (ruleReqs.requirePr) {
                    if (ruleReqs.minApprovals && p.required_pull_request_reviews.required_approving_review_count < ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Classic protection requires ${p.required_pull_request_reviews.required_approving_review_count} approvals, expected >= ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    } else if (isExact && ruleReqs.minApprovals && p.required_pull_request_reviews.required_approving_review_count > ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Classic protection requires ${p.required_pull_request_reviews.required_approving_review_count} approvals, expected exactly ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.dismissStaleReviews && !p.required_pull_request_reviews.dismiss_stale_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection missing dismiss stale reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.dismissStaleReviews && p.required_pull_request_reviews.dismiss_stale_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection has dismiss stale reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireCodeOwnerReviews && !p.required_pull_request_reviews.require_code_owner_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection missing code owner reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireCodeOwnerReviews && p.required_pull_request_reviews.require_code_owner_reviews) {
                      violations.push({ repo, branch, reason: "Classic protection has code owner reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireStatusChecks && !hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Classic protection missing status checks requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireStatusChecks && hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Classic protection has status checks requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireConversationResolution && !p.required_conversation_resolution?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection missing conversation resolution requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireConversationResolution && p.required_conversation_resolution?.enabled) {
                  violations.push({ repo, branch, reason: "Classic protection has conversation resolution requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasStatusChecks) {
                  if (ruleReqs.requireStatusChecks) {
                    if (ruleReqs.strictStatusChecks && !p.required_status_checks.strict) {
                      violations.push({ repo, branch, reason: "Classic protection missing strict status checks requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.strictStatusChecks && p.required_status_checks.strict) {
                      violations.push({ repo, branch, reason: "Classic protection has strict status checks requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireSignedCommits && !hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Classic protection missing signed commits requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireSignedCommits && hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Classic protection has signed commits requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireLinearHistory && !hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Classic protection missing linear history requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireLinearHistory && hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Classic protection has linear history requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.enforceAdmins && !hasEnforceAdmins) {
                  violations.push({ repo, branch, reason: "Classic protection missing enforce admins requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.enforceAdmins && hasEnforceAdmins) {
                  violations.push({ repo, branch, reason: "Classic protection has enforce admins requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventForcePush && !preventsForcePush) {
                  violations.push({ repo, branch, reason: "Classic protection allows force pushing" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventForcePush && preventsForcePush) {
                  violations.push({ repo, branch, reason: "Classic protection prevents force pushing (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventDeletion && !preventsDeletion) {
                  violations.push({ repo, branch, reason: "Classic protection allows branch deletion" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventDeletion && preventsDeletion) {
                  violations.push({ repo, branch, reason: "Classic protection prevents branch deletion (not expected in exact match)" });
                  isRepoCompliant = false;
                }
              } else if (hasRuleset) {
                const allRules = applyingRulesets.flatMap((rs: any) => rs.rules || []);
                const hasRule = (type: string) => allRules.some((r: any) => r.type === type);
                const getRule = (type: string) => allRules.find((r: any) => r.type === type);

                const hasPr = hasRule('pull_request');
                const hasStatusChecks = hasRule('required_status_checks');
                const hasSignedCommits = hasRule('required_signatures');
                const hasLinearHistory = hasRule('required_linear_history');
                const preventsForcePush = hasRule('non_fast_forward');
                const preventsDeletion = hasRule('deletion');
                const isEnforcedForAdmins = applyingRulesets.some((rs: any) => !rs.bypass_actors || rs.bypass_actors.length === 0 || !rs.bypass_actors.some((ba: any) => ba.actor_type === "RepositoryRole" && (ba.repository_role_id === 5 || ba.actor_id === 5) && ba.bypass_mode === "always"));

                if (ruleReqs.requirePr && !hasPr) {
                  violations.push({ repo, branch, reason: "Ruleset missing PR requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requirePr && hasPr) {
                  violations.push({ repo, branch, reason: "Ruleset has PR requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasPr) {
                  if (ruleReqs.requirePr) {
                    const prRule = getRule('pull_request');
                    if (ruleReqs.minApprovals && (prRule.parameters?.required_approving_review_count || 0) < ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Ruleset requires ${prRule.parameters?.required_approving_review_count || 0} approvals, expected >= ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    } else if (isExact && ruleReqs.minApprovals && (prRule.parameters?.required_approving_review_count || 0) > ruleReqs.minApprovals) {
                      violations.push({ repo, branch, reason: `Ruleset requires ${prRule.parameters?.required_approving_review_count || 0} approvals, expected exactly ${ruleReqs.minApprovals}` });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.dismissStaleReviews && !prRule.parameters?.dismiss_stale_reviews_on_push) {
                      violations.push({ repo, branch, reason: "Ruleset missing dismiss stale reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.dismissStaleReviews && prRule.parameters?.dismiss_stale_reviews_on_push) {
                      violations.push({ repo, branch, reason: "Ruleset has dismiss stale reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireCodeOwnerReviews && !prRule.parameters?.require_code_owner_review) {
                      violations.push({ repo, branch, reason: "Ruleset missing code owner reviews requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireCodeOwnerReviews && prRule.parameters?.require_code_owner_review) {
                      violations.push({ repo, branch, reason: "Ruleset has code owner reviews requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }

                    if (ruleReqs.requireConversationResolution && !prRule.parameters?.required_review_thread_resolution) {
                      violations.push({ repo, branch, reason: "Ruleset missing conversation resolution requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.requireConversationResolution && prRule.parameters?.required_review_thread_resolution) {
                      violations.push({ repo, branch, reason: "Ruleset has conversation resolution requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireStatusChecks && !hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Ruleset missing status checks requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireStatusChecks && hasStatusChecks) {
                  violations.push({ repo, branch, reason: "Ruleset has status checks requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (hasStatusChecks) {
                  if (ruleReqs.requireStatusChecks) {
                    const statusRule = getRule('required_status_checks');
                    if (ruleReqs.strictStatusChecks && !statusRule.parameters?.strict_required_status_checks_policy) {
                      violations.push({ repo, branch, reason: "Ruleset missing strict status checks requirement" });
                      isRepoCompliant = false;
                    } else if (isExact && !ruleReqs.strictStatusChecks && statusRule.parameters?.strict_required_status_checks_policy) {
                      violations.push({ repo, branch, reason: "Ruleset has strict status checks requirement (not expected in exact match)" });
                      isRepoCompliant = false;
                    }
                  }
                }

                if (ruleReqs.requireSignedCommits && !hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Ruleset missing signed commits requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireSignedCommits && hasSignedCommits) {
                  violations.push({ repo, branch, reason: "Ruleset has signed commits requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.requireLinearHistory && !hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Ruleset missing linear history requirement" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.requireLinearHistory && hasLinearHistory) {
                  violations.push({ repo, branch, reason: "Ruleset has linear history requirement (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventForcePush && !preventsForcePush) {
                  violations.push({ repo, branch, reason: "Ruleset allows force pushing" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventForcePush && preventsForcePush) {
                  violations.push({ repo, branch, reason: "Ruleset prevents force pushing (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.preventDeletion && !preventsDeletion) {
                  violations.push({ repo, branch, reason: "Ruleset allows branch deletion" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.preventDeletion && preventsDeletion) {
                  violations.push({ repo, branch, reason: "Ruleset prevents branch deletion (not expected in exact match)" });
                  isRepoCompliant = false;
                }

                if (ruleReqs.enforceAdmins && !isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset does not enforce rules for admins" });
                  isRepoCompliant = false;
                } else if (isExact && !ruleReqs.enforceAdmins && isEnforcedForAdmins) {
                  violations.push({ repo, branch, reason: "Ruleset enforces rules for admins (not expected in exact match)" });
                  isRepoCompliant = false;
                }
              }
            }
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
    scannedRepos: reposToScan,
  };

  // A scoped run covers whatever the caller named, which is one repository on
  // the webhook path. Storing it as though it were the whole scan is how the
  // page came to report a single repository and no violations after a push.
  const previous = overrideReposToScan ? await getScanResult(scannerId) : undefined;
  const stored = previous ? mergeScanResult(previous, result, reposToScan) : result;

  if (usesDynamo()) {
    await docClient.send(
      new PutCommand({
        TableName: TABLE(),
        Item: { pk: "RESULT", sk: scannerId, ...stored },
      })
    );
    // lastRunAt is the last *full* run. A webhook re-scanning one repository is
    // not "the scanner ran", and showing it as one hides how long it has been
    // since anything looked at the rest of the organization.
    if (!overrideReposToScan) {
      await docClient.send(
        new PutCommand({
          TableName: TABLE(),
          Item: { pk: "SCANNER", sk: scannerId, ...scanner, lastRunAt: result.runAt, updatedAt: new Date().toISOString() },
        })
      );
    }
  } else {
    memScanResults.set(scannerId, stored);
    if (!overrideReposToScan) {
      scanner.lastRunAt = result.runAt;
      memScanners.set(scannerId, scanner);
    }
  }

  // The caller is told what this run found, not what is now on file — the
  // route logs "scanned N repositories" from it, and that has to be this run.
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
