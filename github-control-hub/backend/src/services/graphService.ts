import { docClient, usesDynamo, tableName, ScanCommand } from "../utils/dynamo";
import { getSystemToken } from "../github/client";
import { rulesetCoversBranch } from "./branchService";
import fs from "fs";
import path from "path";
import {
  listVerdicts, putVerdict, planRefresh, coverageOf, findingsFrom, describeProgress,
  mayRefresh, markRefreshed, budgetFor,
} from "./queryCacheService";

// Fallback for local development
let localEdges: any[] = [];
function loadLocalEdges() {
  if (localEdges.length > 0) return localEdges;
  try {
    const dataDir = path.join(__dirname, "../../../data");
    const filePath = path.join(dataDir, "graph-edges.json");
    if (fs.existsSync(filePath)) {
      localEdges = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.warn("Failed to load local graph edges", e);
  }
  return localEdges;
}

/**
 * How long a read of the whole graph is reused.
 *
 * The graph is rebuilt on a six-hour job, so within any few seconds every reader
 * is looking at identical bytes. Six seconds is long enough to cover one
 * evaluation pass and one page load — the two places several checks run
 * back-to-back — and short enough that a rebuild is picked up almost at once.
 */
const EDGE_CACHE_MS = 6_000;
let edgeCache: { at: number; edges: any[] } | null = null;
let edgeCacheInFlight: Promise<any[]> | null = null;

/**
 * Every edge in the graph. Exported so the access map can derive its own view.
 *
 * Held for a moment rather than re-read per caller. Each security check starts
 * by reading the whole graph, so a pass evaluating six query widgets scanned the
 * same table six times for the same bytes — and at a hundred members across a
 * few hundred repositories that scan is about a megabyte. It was the single
 * largest line in the DynamoDB bill, and none of the six reads could differ.
 *
 * The in-flight promise is shared as well as the result: without it, six checks
 * starting together all miss the cache and all scan, which is the case the cache
 * exists for.
 */
export async function scanGraphEdges(): Promise<any[]> {
  if (!usesDynamo()) return loadLocalEdges();

  if (edgeCache && Date.now() - edgeCache.at < EDGE_CACHE_MS) return edgeCache.edges;
  if (edgeCacheInFlight) return edgeCacheInFlight;

  edgeCacheInFlight = (async () => {
    const items: any[] = [];
    let lastKey: any = undefined;
    do {
      const result: any = await docClient.send(
        new ScanCommand({
          TableName: tableName("GRAPH_EDGES_TABLE"),
          ExclusiveStartKey: lastKey,
        })
      );
      items.push(...(result.Items || []));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey);
    edgeCache = { at: Date.now(), edges: items };
    return items;
  })();

  try {
    return await edgeCacheInFlight;
  } finally {
    // Cleared whether it resolved or threw. A rejected promise left here would
    // be handed to every later caller, so one failed scan would keep failing
    // for as long as the process lived.
    edgeCacheInFlight = null;
  }
}

/** Test seam, and what the aggregator calls after a rebuild. */
export function invalidateEdgeCache(): void {
  edgeCache = null;
  edgeCacheInFlight = null;
}

/**
 * The check works, but the data it reads has never been collected.
 *
 * Without this, a query over an edge type the graph does not yet contain
 * returns nothing and the card reads it as a clean result — "0 repositories
 * with no push in 2 months" when the real answer is 345 and the graph simply
 * has not been rebuilt since that edge type existed. Reporting zero findings
 * you have not looked for is the worst thing a security dashboard can do.
 */
export class MissingGraphDataError extends Error {
  constructor(readonly edgeType: string) {
    super("This check reads data the graph does not have yet. Press Sync data to collect it.");
    this.name = "MissingGraphDataError";
  }
}

/**
 * Edge type each check reads, where its absence means "not collected" rather
 * than "nothing found".
 *
 * Deliberately not listed: has_vulnerable_dependency, where no edges is a
 * legitimate answer — an organization with no open advisories genuinely has
 * none, and claiming missing data would be its own kind of wrong.
 */
const REQUIRES: Record<string, string> = {
  "public-repos": "repo_meta",
  "archived-repos-with-access": "repo_meta",
  "stale-repos": "repo_meta",
  "repos-without-protection": "has_branch",
  "repos-missing-branch": "has_branch",
  "repos-with-unprotected-branch": "has_branch",
  "repos-with-branch": "has_branch",
  "repos-with-branch-rules": "has_branch",
  "stale-branch-protections": "has_branch",
  "highly-privileged-users": "collaborates_on",
  "dormant-privileged-users": "collaborates_on",
  "repos-with-outside-admins": "has_collaborator",
  "unowned-repos": "repo_meta",
};

/** A saved widget naming a check that no longer exists. */
export class UnknownQueryError extends Error {
  constructor(readonly queryId: string) {
    super(`No check named "${queryId}" — it may have been removed.`);
    this.name = "UnknownQueryError";
  }
}

/**
 * The check ran but could not read everything it needed.
 *
 * Distinct from a failure: some of the answer was obtained. It is still refused,
 * because a security check that returns part of its findings returns a number
 * smaller than the truth, and a number smaller than the truth is indistinguishable
 * from an improvement.
 */
export class PartialQueryError extends Error {
  constructor(message: string, readonly covered = 0, readonly total = 0) {
    super(message);
    this.name = "PartialQueryError";
  }
}

/**
 * Whether an error means "there is none" rather than "we could not look".
 *
 * Asking for branch protection on a branch that has none answers 404, and that
 * is a real answer — the branch is unprotected. A 403 or a 502 is not: it means
 * the question went unanswered, and treating it as "unprotected" invents a
 * finding, while treating it as "protected" hides one.
 *
 * Every check below reads protection twice, classic and rulesets, and both
 * legitimately 404. Only the difference between these two cases makes it
 * possible to swallow the harmless one without swallowing the other.
 */
export function isAbsence(err: any): boolean {
  return err?.status === 404;
}

export async function evaluateSecurityQuery(q: string, param?: string, advanced?: any, userToken?: string) {
  const allEdges = await scanGraphEdges();

  const needs = REQUIRES[q];
  if (needs && !allEdges.some(e => e.type === needs)) {
    throw new MissingGraphDataError(needs);
  }

  const results: any[] = [];

  switch (q) {
    case "repos-dependent-on":
      if (!param) throw new Error("Missing 'param' for dependency name");
      // Only vulnerable dependencies are known here: the edges come from
      // Dependabot alerts, not from a dependency graph. A repository using a
      // package with no open advisory has no edge, so this answers "who is
      // exposed through this package", not "who uses it". The label says so.
      //
      // Matched case-insensitively — package names are lower case by
      // convention but nobody types them that way reliably.
      const wanted = new Set(param.split(",").map(x => x.trim().toLowerCase()).filter(Boolean));
      if (wanted.size === 0) throw new Error("Missing 'param' for dependency name");

      // One row per repository, listing every package asked about that it is
      // exposed through. Emitting a row per package instead would count a
      // repository once for each, and the metric card counts rows.
      const byRepo = new Map<string, { pkg: string; severity: string }[]>();
      for (const edge of allEdges) {
        if (edge.type !== "has_vulnerable_dependency") continue;
        const pkg = edge.sk.replace("DEPENDENCY#", "");
        if (!wanted.has(pkg.toLowerCase())) continue;
        const repo = edge.pk.replace("REPO#", "");
        if (!byRepo.has(repo)) byRepo.set(repo, []);
        byRepo.get(repo)!.push({ pkg, severity: edge.metadata?.severity || "unknown" });
      }
      for (const [repo, hits] of byRepo) {
        results.push({
          repo,
          reason: hits.length === 1
            ? `Vulnerable ${hits[0].pkg} (${hits[0].severity})`
            : `Vulnerable in ${hits.length} of the packages asked about`,
          details: hits.map(h => `${h.pkg} (${h.severity})`).join(", "),
        });
      }
      break;

    case "repos-with-outside-admins": {
      // Build a map of repo -> owning team members
      const repoTeamMembers = new Map<string, Set<string>>();
      for (const edge of allEdges) {
        if (edge.type === "owned_by_team") {
          const repo = edge.pk;
          const team = edge.sk;
          if (!repoTeamMembers.has(repo)) repoTeamMembers.set(repo, new Set());
          for (const memberEdge of allEdges) {
            if (memberEdge.pk === team && memberEdge.type === "has_member") {
              repoTeamMembers.get(repo)!.add(memberEdge.sk.replace("USER#", ""));
            }
          }
        }
      }
      for (const edge of allEdges) {
        if (edge.type !== "has_collaborator" || edge.metadata?.role !== "admin") continue;
        // Admin an org owner holds by virtue of the role is not a grant anybody
        // made, and reporting it would name them on every repository the moment
        // teams are assigned — burying the access this check exists to find.
        if (edge.metadata?.source === "org_owner") continue;
        // Access through the owning team is the arrangement working, not a
        // finding; team access to a repo the team does not own still is one.
        const repo = edge.pk;
        const user = edge.sk.replace("USER#", "");
        const teamMembers = repoTeamMembers.get(repo) || new Set();
        if (teamMembers.has(user)) continue;
        results.push({
          repo: repo.replace("REPO#", ""),
          user,
          reason: edge.metadata?.source === "team"
            ? `${user} has admin through a team that does not own this repository`
            : `${user} was granted admin directly and is not on the owning team`,
        });
      }
      break;
    }

    case "highly-privileged-users":
      // Org owners are shown, not hidden. They are admin on everything by
      // virtue of the role, which makes them the most privileged accounts in
      // the organization — omitting them would leave the question "who has the
      // most access" answered by everyone except the people who have the most.
      // How the access was obtained goes in the result instead, so a grant
      // somebody made is distinguishable from one the role confers.
      const userAccessMap = new Map<string, string[]>();
      const userSources = new Map<string, Set<string>>();
      for (const edge of allEdges) {
        if (edge.type === "collaborates_on"
            && ["admin", "write", "maintain"].includes(edge.metadata?.role)) {
          const user = edge.pk.replace("USER#", "");
          if (!userAccessMap.has(user)) userAccessMap.set(user, []);
          userAccessMap.get(user)!.push(edge.sk.replace("REPO#", ""));
          if (!userSources.has(user)) userSources.set(user, new Set());
          userSources.get(user)!.add(edge.metadata?.source ?? "direct");
        }
      }
      const threshold = parseInt(param as string) || 3;
      const HOW: Record<string, string> = {
        org_owner: "organization ownership",
        team: "team membership",
        direct: "a direct grant",
      };
      for (const [user, repos] of userAccessMap.entries()) {
        if (repos.length < threshold) continue;
        const sources = [...(userSources.get(user) ?? [])].map(x => HOW[x] ?? x);
        results.push({
          user,
          reason: `Write or admin on ${repos.length} ${repos.length === 1 ? "repository" : "repositories"}`,
          // Saying how the access was obtained is the difference between a
          // finding somebody can act on and a restatement of the org chart.
          details: `Via ${sources.join(" and ")} · ${repos.slice(0, 5).join(", ")}${repos.length > 5 ? "…" : ""}`,
        });
      }
      // Access somebody granted is more actionable than access the role
      // confers, so those sort first.
      results.sort((a, b) => {
        const owned = (r: any) => (r.details.includes("organization ownership") ? 1 : 0);
        return owned(a) - owned(b);
      });
      break;

    case "unowned-repos":
      const ownedRepos = new Set();
      const allReposSet = new Set();
      for (const edge of allEdges) {
        if (edge.pk.startsWith("REPO#")) allReposSet.add(edge.pk);
        if (edge.type === "owned_by_team") ownedRepos.add(edge.pk);
      }
      for (const repo of allReposSet) {
        if (!ownedRepos.has(repo)) {
          results.push({
            repo: (repo as string).replace("REPO#", ""),
            reason: "No team assigned as owner"
          });
        }
      }
      break;

    case "repos-missing-branch": {
      if (!param) throw new Error("Missing 'param' for branch name");
      const branchNames = param.split(",").map(b => b.trim()).filter(Boolean);
      const allReposForBranch = new Set<string>();
      const repoBranches = new Map<string, Set<string>>();
      for (const edge of allEdges) {
        if (edge.pk.startsWith("REPO#")) {
          allReposForBranch.add(edge.pk);
          if (edge.type === "has_branch") {
            if (!repoBranches.has(edge.pk)) repoBranches.set(edge.pk, new Set());
            repoBranches.get(edge.pk)!.add(edge.sk.replace("BRANCH#", ""));
          }
        }
      }
      for (const repo of allReposForBranch) {
        const hasBranches = repoBranches.get(repo) || new Set();
        const missing = branchNames.filter(b => !hasBranches.has(b));
        if (missing.length > 0) {
          results.push({
            repo: (repo as string).replace("REPO#", ""),
            reason: `Missing branch${missing.length > 1 ? "es" : ""}: ${missing.join(", ")}`
          });
        }
      }
      break;
    }

    case "repos-with-unprotected-branch": {
      if (!param) throw new Error("Missing 'param' for branch name");
      const unprotBranchNames = param.split(",").map(b => b.trim()).filter(Boolean);
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.metadata?.protected === false) {
          const bName = edge.sk.replace("BRANCH#", "");
          if (unprotBranchNames.includes(bName)) {
            results.push({
              repo: edge.pk.replace("REPO#", ""),
              reason: `Branch '${bName}' exists but is NOT protected`
            });
          }
        }
      }
      break;
    }

    case "repos-with-branch": {
      if (!param) throw new Error("Missing 'param' for branch name");
      const wantedBranches = param.split(",").map(b => b.trim()).filter(Boolean);
      const repoFoundBranches = new Map<string, Set<string>>();
      for (const edge of allEdges) {
        if (edge.type === "has_branch") {
          const bName = edge.sk.replace("BRANCH#", "");
          if (wantedBranches.includes(bName)) {
            if (!repoFoundBranches.has(edge.pk)) repoFoundBranches.set(edge.pk, new Set());
            repoFoundBranches.get(edge.pk)!.add(bName);
          }
        }
      }
      for (const [repoPk, found] of repoFoundBranches) {
        if (found.size === wantedBranches.length) {
          results.push({
            repo: repoPk.replace("REPO#", ""),
            reason: `Has branch${wantedBranches.length > 1 ? "es" : ""}: ${wantedBranches.join(", ")}`
          });
        }
      }
      break;
    }

    case "repos-with-branch-rules": {
      if (!param) throw new Error("Missing 'param' for branch name");
      const targetBranches = param.split(",").map(b => b.trim()).filter(Boolean);
      const toBool = (v: unknown) => v === true || v === "true";
      const reqProtType = (advanced?.protectionType as string) || "any";
      const reqMatchMode = (advanced?.ruleMatchType as string) || "at_least";
      const protTypeLabel = reqProtType === "classic" ? "Classic protection" : reqProtType === "ruleset" ? "Repository ruleset" : "Any protection";

      const wantRules = {
        requirePr: toBool(advanced?.requirePr),
        minApprovals: Number(advanced?.minApprovals) || 0,
        dismissStaleReviews: toBool(advanced?.dismissStaleReviews),
        requireCodeOwnerReviews: toBool(advanced?.requireCodeOwnerReviews),
        requireConversationResolution: toBool(advanced?.requireConversationResolution),
        requireStatusChecks: toBool(advanced?.requireStatusChecks),
        strictStatusChecks: toBool(advanced?.strictStatusChecks),
        requireSignedCommits: toBool(advanced?.requireSignedCommits),
        requireLinearHistory: toBool(advanced?.requireLinearHistory),
        enforceAdmins: toBool(advanced?.enforceAdmins),
        preventForcePush: toBool(advanced?.preventForcePush),
        preventDeletion: toBool(advanced?.preventDeletion),
      };

      const allRepoNames = new Set<string>();
      const repoHasBranch = new Map<string, Set<string>>();
      // Which branch each repository calls its default, so a ruleset scoped to
      // ~DEFAULT_BRANCH is read against the repository it belongs to rather
      // than against the literal "main".
      const defaultBranchOf = new Map<string, string>();
      for (const edge of allEdges) {
        if (edge.type === "repo_meta" && edge.metadata?.defaultBranch) {
          defaultBranchOf.set(edge.pk.replace("REPO#", ""), String(edge.metadata.defaultBranch));
        }
        if (edge.pk.startsWith("REPO#")) {
          allRepoNames.add(edge.pk.replace("REPO#", ""));
          if (edge.type === "has_branch") {
            const bName = edge.sk.replace("BRANCH#", "");
            if (targetBranches.includes(bName)) {
              const repoName = edge.pk.replace("REPO#", "");
              if (!repoHasBranch.has(repoName)) repoHasBranch.set(repoName, new Set());
              repoHasBranch.get(repoName)!.add(bName);
            }
          }
        }
      }

      for (const repo of allRepoNames) {
        const hasBranches = repoHasBranch.get(repo) || new Set();
        const missingBranches = targetBranches.filter(b => !hasBranches.has(b));
        if (missingBranches.length > 0) {
          results.push({
            repo,
            status: "fail",
            reason: `Missing branch${missingBranches.length > 1 ? "es" : ""}: ${missingBranches.join(", ")}`,
          });
          continue;
        }
      }

      const reposToCheck = Array.from(allRepoNames).filter(repo => {
        const hasBranches = repoHasBranch.get(repo) || new Set();
        return targetBranches.every(b => hasBranches.has(b));
      });

      const token = userToken || getSystemToken();
      if (!token) throw new Error("Authentication required for live rule evaluation");
      const { Octokit } = await import("octokit");
      const { getOrg } = await import("../github/client");
      const octokit = new Octokit({ auth: token });
      const org = getOrg();

      for (const repo of reposToCheck) {
        let allBranchesPass = true;
        const branchSummaries: string[] = [];
        const failureDetails: string[] = [];

        let repoRulesetsCache: any[] | null = null;

        for (const branch of targetBranches) {
          let hasClassic = false;
          let hasRuleset = false;

          const found = {
            requirePr: false, minApprovals: 0, dismissStaleReviews: false,
            requireCodeOwnerReviews: false, requireConversationResolution: false,
            requireStatusChecks: false, strictStatusChecks: false,
            requireSignedCommits: false, requireLinearHistory: false,
            enforceAdmins: false, preventForcePush: false, preventDeletion: false,
          };

          try {
            const { data: prot } = await octokit.rest.repos.getBranchProtection({ owner: org, repo, branch });
            hasClassic = true;
            if (prot.required_pull_request_reviews) {
              found.requirePr = true;
              found.minApprovals = Math.max(found.minApprovals, prot.required_pull_request_reviews.required_approving_review_count || 0);
              if (prot.required_pull_request_reviews.dismiss_stale_reviews) found.dismissStaleReviews = true;
              if (prot.required_pull_request_reviews.require_code_owner_reviews) found.requireCodeOwnerReviews = true;
            }
            if ((prot as any).required_conversation_resolution?.enabled) found.requireConversationResolution = true;
            if (prot.required_status_checks) {
              found.requireStatusChecks = true;
              if (prot.required_status_checks.strict) found.strictStatusChecks = true;
            }
            if ((prot as any).required_signatures?.enabled) found.requireSignedCommits = true;
            if ((prot as any).required_linear_history?.enabled) found.requireLinearHistory = true;
            if (prot.enforce_admins?.enabled) found.enforceAdmins = true;
            if ((prot as any).allow_force_pushes?.enabled === false || ((prot as any).allow_force_pushes === undefined)) found.preventForcePush = true;
            if ((prot as any).allow_deletions?.enabled === false || ((prot as any).allow_deletions === undefined)) found.preventDeletion = true;
          } catch { /* no classic protection */ }

          try {
            if (!repoRulesetsCache) {
              const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: org, repo });
              repoRulesetsCache = [];
              for (const rs of rulesets) {
                if (rs.target === "branch") {
                  const { data: rsDetails } = await octokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { owner: org, repo, ruleset_id: rs.id });
                  repoRulesetsCache.push(rsDetails);
                }
              }
            }
            for (const rsDetails of repoRulesetsCache) {
              // GitHub's own ref semantics. `refs.some(r => r.includes(branch))`
              // is a substring test, so a ruleset on refs/heads/maintenance
              // "covered" main — this check reported protection that was not
              // there, on the branch it most matters for.
              const applies = rulesetCoversBranch(
                rsDetails.conditions?.ref_name?.include, branch, defaultBranchOf.get(repo));

              if (applies) {
                hasRuleset = true;
                const rulesetRules = rsDetails.rules || [];
                if (rulesetRules.some((r: any) => r.type === "pull_request")) {
                  found.requirePr = true;
                  const prRule = rulesetRules.find((r: any) => r.type === "pull_request");
                  found.minApprovals = Math.max(found.minApprovals, prRule?.parameters?.required_approving_review_count || 0);
                  if (prRule?.parameters?.dismiss_stale_reviews_on_push) found.dismissStaleReviews = true;
                  if (prRule?.parameters?.require_code_owner_review) found.requireCodeOwnerReviews = true;
                }
                if (rulesetRules.some((r: any) => r.type === "required_status_checks")) found.requireStatusChecks = true;
                if (rulesetRules.some((r: any) => r.type === "required_signatures")) found.requireSignedCommits = true;
                if (rulesetRules.some((r: any) => r.type === "required_linear_history")) found.requireLinearHistory = true;
                if (rulesetRules.some((r: any) => r.type === "non_fast_forward")) found.preventForcePush = true;
                if (rulesetRules.some((r: any) => r.type === "deletion")) found.preventDeletion = true;
              }
            }
          } catch { /* no rulesets */ }

          let typeMatch = false;
          let matchedType = "";
          if (reqProtType === "classic" && hasClassic) { typeMatch = true; matchedType = "Classic"; }
          if (reqProtType === "ruleset" && hasRuleset) { typeMatch = true; matchedType = "Ruleset"; }
          if (reqProtType === "any" && (hasClassic || hasRuleset)) { typeMatch = true; matchedType = hasRuleset ? "Ruleset" : "Classic"; }

          if (!typeMatch) {
            allBranchesPass = false;
            if (!hasClassic && !hasRuleset) {
              failureDetails.push(`"${branch}": No protection rules found`);
            } else {
              failureDetails.push(`"${branch}": No ${protTypeLabel.toLowerCase()} found (has ${hasClassic ? "Classic" : ""}${hasClassic && hasRuleset ? " & " : ""}${hasRuleset ? "Ruleset" : ""} only)`);
            }
            continue;
          }

          if (reqMatchMode === "any") {
            branchSummaries.push(`${branch}: ${matchedType}`);
            continue;
          }

          const matched: string[] = [];
          const missed: string[] = [];

          const checkRule = (label: string, wanted: boolean, actual: boolean) => {
            if (wanted) { if (actual) matched.push(label); else missed.push(label); }
            else if (reqMatchMode === "exact" && actual) missed.push(`unexpected: ${label}`);
          };

          checkRule("PRs", wantRules.requirePr, found.requirePr);
          checkRule("Dismiss stale reviews", wantRules.dismissStaleReviews, found.dismissStaleReviews);
          checkRule("Code Owner reviews", wantRules.requireCodeOwnerReviews, found.requireCodeOwnerReviews);
          checkRule("Conversation resolution", wantRules.requireConversationResolution, found.requireConversationResolution);
          checkRule("Status checks", wantRules.requireStatusChecks, found.requireStatusChecks);
          checkRule("Strict status checks", wantRules.strictStatusChecks, found.strictStatusChecks);
          checkRule("Signed commits", wantRules.requireSignedCommits, found.requireSignedCommits);
          checkRule("Linear history", wantRules.requireLinearHistory, found.requireLinearHistory);
          checkRule("Enforce admins", wantRules.enforceAdmins, found.enforceAdmins);
          checkRule("Prevent force push", wantRules.preventForcePush, found.preventForcePush);
          checkRule("Prevent deletion", wantRules.preventDeletion, found.preventDeletion);

          if (wantRules.minApprovals > 0 && found.minApprovals < wantRules.minApprovals) {
            missed.push(`Min ${wantRules.minApprovals} approvals (found ${found.minApprovals})`);
          } else if (wantRules.minApprovals > 0) {
            matched.push(`${found.minApprovals} approvals`);
          }

          if (missed.length > 0) {
            allBranchesPass = false;
            failureDetails.push(`"${branch}": Missing rules — ${missed.join(", ")}`);
          } else {
            branchSummaries.push(`${branch}: ${matchedType}${matched.length ? ` (${matched.join(", ")})` : ""}`);
          }
        }

        if (allBranchesPass) {
          results.push({ repo, status: "pass", reason: branchSummaries.join(" | ") });
        } else {
          results.push({ repo, status: "fail", reason: failureDetails.join(" | ") });
        }
      }

      results.sort((a, b) => {
        if (a.status === "pass" && b.status !== "pass") return -1;
        if (a.status !== "pass" && b.status === "pass") return 1;
        return 0;
      });

      break;
    }

    case "stale-branch-protections": {
      const sbpToken = userToken || getSystemToken();
      if (!sbpToken) throw new Error("Authentication required for live evaluation");
      const { Octokit: SbpOctokit } = await import("octokit");
      const { getOrg: sbpGetOrg } = await import("../github/client");
      const sbpOctokit = new SbpOctokit({ auth: sbpToken });
      const sbpOrg = sbpGetOrg();

      const protectedRepos = new Set<string>();
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.metadata?.protected) {
          protectedRepos.add(edge.pk.replace("REPO#", ""));
        }
      }

      // Every protected repository, not the first 20.
      //
      // This used to be `.slice(0, 20)`, which kept the cost down by looking at
      // 20 repositories and saying nothing about the rest — so on an organization
      // with three hundred protected repositories the check was a sample
      // presented as a survey. The cost is now spread instead: each pass reads a
      // batch, the verdicts are kept per repository, and the answer is withheld
      // until every one of them has been covered.
      const sbpSubjects = Array.from(protectedRepos).sort();
      const sbpCached = await listVerdicts("stale-branch-protections");
      const sbpMay = mayRefresh("stale-branch-protections");
      const { refresh: reposToCheckSBP, known: sbpKnown } =
        planRefresh(sbpSubjects, sbpCached, sbpMay ? budgetFor("stale-branch-protections") : 0);
      if (sbpMay) markRefreshed("stale-branch-protections");
      const unreadable: string[] = [];

      for (const repo of reposToCheckSBP) {
        let requiredReviews = 0;

        // Find the default branch from graph data, fall back to "main"
        const sbpRepoBranches = allEdges.filter(e => e.pk === `REPO#${repo}` && e.type === "has_branch");
        const sbpDefaultBranch = sbpRepoBranches.find(e => e.metadata?.default)?.sk.replace("BRANCH#", "") || "main";

        let readable = true;

        try {
          const { data: prot } = await sbpOctokit.rest.repos.getBranchProtection({ owner: sbpOrg, repo, branch: sbpDefaultBranch });
          if (prot.required_pull_request_reviews?.required_approving_review_count) {
            requiredReviews = Math.max(requiredReviews, prot.required_pull_request_reviews.required_approving_review_count);
          }
        } catch (e) {
          // 404 is the branch simply having no classic protection, which is an
          // answer. Anything else left requiredReviews at zero for a reason we
          // never saw — and zero means "no requirement to bypass", so the
          // repository drops out of the findings looking compliant.
          if (!isAbsence(e)) readable = false;
        }
        
        try {
          const { data: rulesets } = await sbpOctokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: sbpOrg, repo });
          for (const rs of rulesets) {
            if (rs.target === "branch") {
              const { data: rsDetails } = await sbpOctokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { owner: sbpOrg, repo, ruleset_id: rs.id });
              const rules = rsDetails.rules || [];
              const prRule = rules.find((r: any) => r.type === "pull_request") as any;
              if (prRule && prRule.parameters?.required_approving_review_count) {
                requiredReviews = Math.max(requiredReviews, prRule.parameters.required_approving_review_count);
              }
            }
          }
        } catch (e) {
          if (!isAbsence(e)) readable = false;
        }

        if (!readable) {
          unreadable.push(repo);
          continue;
        }

        if (requiredReviews === 0) {
          // Nothing required means nothing to bypass. A verdict, so the
          // repository counts as covered.
          sbpKnown.set(repo, await putVerdict("stale-branch-protections", repo, null));
        }

        if (requiredReviews > 0) {
          try {
            const queryStr = `
              query($owner: String!, $repo: String!) {
                repository(owner: $owner, name: $repo) {
                  pullRequests(states: MERGED, last: 10) {
                    nodes {
                      reviews(states: APPROVED) {
                        totalCount
                      }
                    }
                  }
                }
              }
            `;
            const data: any = await sbpOctokit.graphql(queryStr, { owner: sbpOrg, repo });
            const prs = data.repository?.pullRequests?.nodes;
            if (prs && prs.length > 0) {
              const totalApprovals = prs.reduce((sum: number, pr: any) => sum + (pr.reviews?.totalCount || 0), 0);
              const avgReviews = totalApprovals / prs.length;

              sbpKnown.set(repo, await putVerdict("stale-branch-protections", repo,
                avgReviews < requiredReviews
                  ? {
                      repo,
                      reason: `Requires ${requiredReviews} reviewers, but recent PRs average ${avgReviews.toFixed(1)} approving reviews`,
                      details: "Protections are likely being bypassed (e.g., by admins)",
                    }
                  : null));
            } else {
              // No merged pull requests to judge by is a clean verdict, not a
              // gap. Leaving it unstored would keep the repository permanently
              // uncovered and the answer permanently withheld.
              sbpKnown.set(repo, await putVerdict("stale-branch-protections", repo, null));
            }
          } catch (e) {
            // The repository requires reviews and we could not read whether they
            // happened. Silence here reports it as compliant.
            unreadable.push(repo);
          }
        }
      }

      const sbpCoverage = coverageOf(sbpSubjects, sbpKnown);
      if (!sbpCoverage.complete) {
        throw new PartialQueryError(
          describeProgress("Stale Branch Protection", sbpCoverage)
          + (unreadable.length ? ` Could not read: ${unreadable.slice(0, 3).join(", ")}.` : ""),
          sbpCoverage.covered, sbpCoverage.total,
        );
      }
      results.push(...findingsFrom(sbpSubjects, sbpKnown));
      break;
    }

    case "protection-bypasses-ranking": {
      const pbrToken = userToken || getSystemToken();
      if (!pbrToken) throw new Error("Authentication required for live evaluation");
      const { Octokit: PbrOctokit } = await import("octokit");
      const { getOrg: pbrGetOrg } = await import("../github/client");
      const pbrOctokit = new PbrOctokit({ auth: pbrToken });
      const pbrOrg = pbrGetOrg();

      const protectedRepos = new Set<string>();
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.metadata?.protected) {
          protectedRepos.add(edge.pk.replace("REPO#", ""));
        }
      }

      // In real scenario we might do all, but limit to 30 to avoid rate limits
      // Every protected repository, not the first 30.
      //
      // This used to be `.slice(0, 30)`, which kept the cost down by looking at
      // 30 repositories and saying nothing about the rest — so on an organization
      // with three hundred protected repositories the check was a sample
      // presented as a survey. The cost is now spread instead: each pass reads a
      // batch, the verdicts are kept per repository, and the answer is withheld
      // until every one of them has been covered.
      const pbrSubjects = Array.from(protectedRepos).sort();
      const pbrCached = await listVerdicts("protection-bypasses-ranking");
      const pbrMay = mayRefresh("protection-bypasses-ranking");
      const { refresh: reposToCheckPBR, known: pbrKnown } =
        planRefresh(pbrSubjects, pbrCached, pbrMay ? budgetFor("protection-bypasses-ranking") : 0);
      if (pbrMay) markRefreshed("protection-bypasses-ranking");
      const unreadable: string[] = [];

      for (const repo of reposToCheckPBR) {
        let requiredReviews = 0;

        // Find the default branch from graph data, fall back to "main"
        const pbrRepoBranches = allEdges.filter(e => e.pk === `REPO#${repo}` && e.type === "has_branch");
        const pbrDefaultBranch = pbrRepoBranches.find(e => e.metadata?.default)?.sk.replace("BRANCH#", "") || "main";

        let readable = true;

        try {
          const { data: prot } = await pbrOctokit.rest.repos.getBranchProtection({ owner: pbrOrg, repo, branch: pbrDefaultBranch });
          if (prot.required_pull_request_reviews?.required_approving_review_count) {
            requiredReviews = Math.max(requiredReviews, prot.required_pull_request_reviews.required_approving_review_count);
          }
        } catch (e) {
          // 404 is the branch simply having no classic protection, which is an
          // answer. Anything else left requiredReviews at zero for a reason we
          // never saw — and zero means "no requirement to bypass", so the
          // repository drops out of the findings looking compliant.
          if (!isAbsence(e)) readable = false;
        }
        
        try {
          const { data: rulesets } = await pbrOctokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: pbrOrg, repo });
          for (const rs of rulesets) {
            if (rs.target === "branch") {
              const { data: rsDetails } = await pbrOctokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", { owner: pbrOrg, repo, ruleset_id: rs.id });
              const rules = rsDetails.rules || [];
              const prRule = rules.find((r: any) => r.type === "pull_request") as any;
              if (prRule && prRule.parameters?.required_approving_review_count) {
                requiredReviews = Math.max(requiredReviews, prRule.parameters.required_approving_review_count);
              }
            }
          }
        } catch (e) {
          if (!isAbsence(e)) readable = false;
        }

        if (!readable) {
          unreadable.push(repo);
          continue;
        }

        if (requiredReviews === 0) {
          pbrKnown.set(repo, await putVerdict("protection-bypasses-ranking", repo, null));
        }

        if (requiredReviews > 0) {
          try {
            const queryStr = `
              query($owner: String!, $repo: String!) {
                repository(owner: $owner, name: $repo) {
                  pullRequests(states: MERGED, last: 20) {
                    nodes {
                      reviews(states: APPROVED) {
                        totalCount
                      }
                    }
                  }
                }
              }
            `;
            const data: any = await pbrOctokit.graphql(queryStr, { owner: pbrOrg, repo });
            const prs = data.repository?.pullRequests?.nodes || [];
            
            let bypassCount = 0;
            for (const pr of prs) {
              if ((pr.reviews?.totalCount || 0) < requiredReviews) {
                bypassCount++;
              }
            }

            pbrKnown.set(repo, await putVerdict("protection-bypasses-ranking", repo,
              bypassCount > 0
                ? {
                    repo,
                    bypasses: bypassCount,
                    reason: `${bypassCount} out of last ${prs.length} PRs bypassed the ${requiredReviews} reviewers requirement`,
                    score: bypassCount, // we will use this to sort later
                  }
                : null));
          } catch (e) {
            unreadable.push(repo);
          }
        }
      }

      const pbrCoverage = coverageOf(pbrSubjects, pbrKnown);
      if (!pbrCoverage.complete) {
        throw new PartialQueryError(
          describeProgress("Protection Rule Bypasses", pbrCoverage)
          + (unreadable.length ? ` Could not read: ${unreadable.slice(0, 3).join(", ")}.` : ""),
          pbrCoverage.covered, pbrCoverage.total,
        );
      }
      results.push(...findingsFrom(pbrSubjects, pbrKnown) as any[]);

      // Sort by bypass count descending
      results.sort((a, b) => b.score - a.score);
      break;
    }

    case "public-repos": {
      // Becoming public raises an alert; being public raises nothing, so an
      // organization could be full of public repositories and the app would
      // have said so once, months ago, in a feed.
      for (const edge of allEdges) {
        if (edge.type !== "repo_meta") continue;
        const visibility = String(edge.metadata?.visibility ?? "private");
        if (visibility === "private") continue;
        results.push({
          repo: edge.pk.replace("REPO#", ""),
          reason: visibility === "internal"
            ? "Visible to everyone in the enterprise"
            : "Visible to anyone on the internet",
          details: `visibility: ${visibility}`,
        });
      }
      break;
    }

    case "archived-repos-with-access": {
      // An archived repository is read-only on GitHub's side, but the access
      // list is not: the people on it keep whatever the repository can still
      // give them, and nobody reviews a repository they consider finished.
      const archived = new Set<string>();
      for (const edge of allEdges) {
        if (edge.type === "repo_meta" && edge.metadata?.archived) archived.add(edge.pk);
      }

      const holders = new Map<string, Map<string, string>>();
      for (const edge of allEdges) {
        if (edge.type !== "has_collaborator" || !archived.has(edge.pk)) continue;
        // Access the org role confers is not something anyone granted to this
        // repository, and would name the owner on every archived one.
        if (edge.metadata?.source === "org_owner") continue;
        if (!holders.has(edge.pk)) holders.set(edge.pk, new Map());
        holders.get(edge.pk)!.set(edge.sk.replace("USER#", ""), edge.metadata?.role ?? "read");
      }

      for (const [repoId, users] of holders) {
        if (users.size === 0) continue;
        const names = [...users.keys()];
        // The strongest grant anyone still holds, rather than the words "write
        // or admin".
        //
        // That phrase was accurate when the graph only recorded write and
        // above. It records triage, custom roles and an outside collaborator's
        // read now, so the sentence became a claim about the data rather than a
        // reading of it — and "still has write or admin" over a row that is
        // actually a read grant is the kind of wrong that gets acted on.
        const RANK: Record<string, number> = {
          admin: 5, maintain: 4, write: 3, push: 3, triage: 2, read: 1, pull: 1,
        };
        const strongest = [...users.values()]
          .sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? "read";
        results.push({
          repo: repoId.replace("REPO#", ""),
          reason: `Archived, but ${names.length} ${names.length === 1 ? "account still has" : "accounts still have"} access (up to ${strongest})`,
          details: [...users].slice(0, 6).map(([u, r]) => `${u} (${r})`).join(", ")
            + (names.length > 6 ? "…" : ""),
        });
      }
      break;
    }

    case "stale-repos": {
      // Months, because a threshold in days invites arguing about 89 versus 90.
      const months = Math.max(1, parseInt(String(param ?? "6"), 10) || 6);
      const cutoff = new Date();
      cutoff.setUTCMonth(cutoff.getUTCMonth() - months);

      for (const edge of allEdges) {
        if (edge.type !== "repo_meta") continue;
        // An archived repository is stale by definition — archiving is the act
        // of retiring it — so reporting it here says only that somebody did
        // what they meant to. The archived check covers what is still worth
        // knowing about those.
        if (edge.metadata?.archived) continue;

        const pushedAt = edge.metadata?.pushedAt;
        // A repository that has never been pushed to is empty rather than
        // abandoned, and saying it is stale would be a different claim.
        if (!pushedAt) continue;
        const when = new Date(pushedAt);
        if (isNaN(when.getTime()) || when >= cutoff) continue;
        const days = Math.floor((Date.now() - when.getTime()) / 86_400_000);
        results.push({
          repo: edge.pk.replace("REPO#", ""),
          reason: `No push in ${Math.floor(days / 30)} months`,
          details: `last push ${when.toISOString().slice(0, 10)}`,
        });
      }
      break;
    }

    case "repos-without-protection": {
      // "Is main unprotected" cannot answer this: a repository whose default
      // branch is called something else passes that check by not having a main
      // to be unprotected, while protecting nothing at all.
      const branchCount = new Map<string, number>();
      const protectedCount = new Map<string, number>();
      for (const edge of allEdges) {
        if (edge.type !== "has_branch") continue;
        branchCount.set(edge.pk, (branchCount.get(edge.pk) ?? 0) + 1);
        if (edge.metadata?.protected) protectedCount.set(edge.pk, (protectedCount.get(edge.pk) ?? 0) + 1);
      }

      const defaultBranch = new Map<string, string>();
      for (const edge of allEdges) {
        if (edge.type === "repo_meta" && edge.metadata?.defaultBranch) {
          defaultBranch.set(edge.pk, String(edge.metadata.defaultBranch));
        }
      }

      for (const [repoId, branches] of branchCount) {
        if ((protectedCount.get(repoId) ?? 0) > 0) continue;
        const dflt = defaultBranch.get(repoId);
        results.push({
          repo: repoId.replace("REPO#", ""),
          reason: `No protected branch of ${branches}`,
          details: dflt ? `default branch: ${dflt}` : "",
        });
      }
      break;
    }

    case "empty-teams":
      const teamsWithMembers = new Set();
      const allTeamsSet = new Set();
      for (const edge of allEdges) {
        if (edge.pk.startsWith("TEAM#")) allTeamsSet.add(edge.pk);
        if (edge.type === "has_member") teamsWithMembers.add(edge.pk);
      }
      for (const team of allTeamsSet) {
        if (!teamsWithMembers.has(team)) {
          results.push({
            team: (team as string).replace("TEAM#", ""),
            reason: "Team has no members"
          });
        }
      }
      break;

    case "dormant-privileged-users": {
      const dormToken = userToken || getSystemToken();
      if (!dormToken) throw new Error("Authentication required for live evaluation");
      const { Octokit: DormOctokit } = await import("octokit");
      const { getOrg: dormGetOrg } = await import("../github/client");
      const dormOctokit = new DormOctokit({ auth: dormToken });
      const dormOrg = dormGetOrg();

      const userAccessMap = new Map<string, string[]>();
      for (const edge of allEdges) {
        // Org owners included: a dormant account with admin everywhere is the
        // most serious version of this finding, not one to leave out.
        if (edge.type === "collaborates_on"
            && ["admin", "maintain"].includes(edge.metadata?.role)) {
          const u = edge.pk.replace("USER#", "");
          if (!userAccessMap.has(u)) userAccessMap.set(u, []);
          userAccessMap.get(u)!.push(edge.sk.replace("REPO#", ""));
        }
      }

      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const since = sixMonthsAgo.toISOString().split("T")[0];

      const candidates = [...userAccessMap.entries()].filter(([, repos]) => repos.length >= 2);
      const dormSubjects = candidates.map(([u]) => u);

      // Cached per account rather than re-read every pass. One commit search
      // each, against a limit of thirty a minute, for a question whose answer
      // moves on the scale of months — so a few hundred accounts are covered a
      // batch at a time instead of needing a budget nobody has.
      const dormCached = await listVerdicts("dormant-privileged-users");
      // Zero budget when another caller refreshed moments ago: read what is
      // stored rather than spending a second batch inside the same minute.
      const dormMay = mayRefresh("dormant-privileged-users");
      const { refresh: dormRefresh, known: dormKnown } =
        planRefresh(dormSubjects, dormCached, dormMay ? budgetFor("dormant-privileged-users") : 0);
      if (dormMay) markRefreshed("dormant-privileged-users");
      const dormRepos = new Map(candidates);

      // One search per candidate, and search is the small budget — 30 requests
      // a *minute*, not the 15,000 an hour the rest of the app draws on. An
      // organization with more privileged users than that cannot be checked in
      // one pass, and finding that out request by request means finding it out
      // halfway through.
      const unchecked: string[] = [];

      for (const u of dormRefresh) {
        const repos = dormRepos.get(u)!;
        try {
          const { data: searchData } = await dormOctokit.rest.search.commits({
            q: `author:${u} org:${dormOrg} committer-date:>=${since}`,
          });

          // Stored either way. "Checked and active" is an answer worth keeping;
          // storing only findings would make a clean account indistinguishable
          // from one never reached, and coverage could never complete.
          const finding = searchData.total_count === 0
            ? {
                user: u,
                reason: `Dormant high-privilege account`,
                details: `Admin of ${repos.length} repos, but 0 commits in the org in the last 6 months`,
                adminRepos: repos.length,
              }
            : null;
          dormKnown.set(u, await putVerdict("dormant-privileged-users", u, finding));
        } catch (err) {
          // Not swallowed.
          //
          // A result is only recorded when the search comes back with zero
          // commits, so an error that is caught and dropped removes that person
          // from the answer entirely — and the widget reports *fewer* dormant
          // admins than exist. No error, no warning, just a smaller number: the
          // one failure mode a security check must never have. It was written
          // as `catch(e) {}` and would have started under-reporting silently the
          // moment the organization outgrew the search budget.
          unchecked.push(u);
        }
      }

      // Refused rather than returned partial. "Twenty of forty-five admins are
      // dormant" is not a smaller finding, it is an unreliable one, and the
      // alarm evaluator already knows what to do with no reading: leave the
      // state alone rather than resolve it. A partial list would instead look
      // like an improvement.
      const dormCoverage = coverageOf(dormSubjects, dormKnown);
      if (!dormCoverage.complete) {
        throw new PartialQueryError(
          describeProgress("Dormant Privileged Access", dormCoverage)
          + (unchecked.length ? ` Could not read: ${unchecked.slice(0, 3).join(", ")}.` : ""),
          dormCoverage.covered, dormCoverage.total,
        );
      }
      results.push(...findingsFrom(dormSubjects, dormKnown));
      break;
    }

    default:
      // A widget saved against a check that has since been removed. Retrying
      // it on a timer produced a page of stack traces and no explanation, so
      // it is named and typed for the route to turn into something readable.
      throw new UnknownQueryError(q);
  }

  // Deduplicate results based on primary entity
  const dedupedMap = new Map();
  for (const r of results) {
    const key = r.repo || r.user || r.team;
    if (!dedupedMap.has(key)) {
      dedupedMap.set(key, r);
    } else {
      const existing = dedupedMap.get(key);
      existing.reason += ` | ${r.reason}`;
    }
  }

  return Array.from(dedupedMap.values());
}
