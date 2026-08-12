import { docClient, usesDynamo, tableName, ScanCommand } from "../utils/dynamo";
import { getSystemToken } from "../github/client";
import fs from "fs";
import path from "path";

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

async function scanAllEdges(): Promise<any[]> {
  if (!usesDynamo()) return loadLocalEdges();
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
  return items;
}

export async function evaluateSecurityQuery(q: string, param?: string, advanced?: any, userToken?: string) {
  const allEdges = await scanAllEdges();

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
      // the organisation — omitting them would leave the question "who has the
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
        org_owner: "organisation ownership",
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
        const owned = (r: any) => (r.details.includes("organisation ownership") ? 1 : 0);
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
      for (const edge of allEdges) {
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
              const refs = rsDetails.conditions?.ref_name?.include || [];
              const applies = refs.includes(`refs/heads/${branch}`) ||
                refs.some((r: string) => r.includes(branch)) ||
                (refs.includes("~DEFAULT_BRANCH") && branch === "main");

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

      const reposToCheckSBP = Array.from(protectedRepos).slice(0, 20);

      for (const repo of reposToCheckSBP) {
        let requiredReviews = 0;

        // Find the default branch from graph data, fall back to "main"
        const sbpRepoBranches = allEdges.filter(e => e.pk === `REPO#${repo}` && e.type === "has_branch");
        const sbpDefaultBranch = sbpRepoBranches.find(e => e.metadata?.default)?.sk.replace("BRANCH#", "") || "main";

        try {
          const { data: prot } = await sbpOctokit.rest.repos.getBranchProtection({ owner: sbpOrg, repo, branch: sbpDefaultBranch });
          if (prot.required_pull_request_reviews?.required_approving_review_count) {
            requiredReviews = Math.max(requiredReviews, prot.required_pull_request_reviews.required_approving_review_count);
          }
        } catch(e) {}
        
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
        } catch(e) {}

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

              if (avgReviews < requiredReviews) {
                results.push({
                  repo,
                  reason: `Requires ${requiredReviews} reviewers, but recent PRs average ${avgReviews.toFixed(1)} approving reviews`,
                  details: "Protections are likely being bypassed (e.g., by admins)"
                });
              }
            }
          } catch(e) {}
        }
      }
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
      const reposToCheckPBR = Array.from(protectedRepos).slice(0, 30);

      for (const repo of reposToCheckPBR) {
        let requiredReviews = 0;

        // Find the default branch from graph data, fall back to "main"
        const pbrRepoBranches = allEdges.filter(e => e.pk === `REPO#${repo}` && e.type === "has_branch");
        const pbrDefaultBranch = pbrRepoBranches.find(e => e.metadata?.default)?.sk.replace("BRANCH#", "") || "main";

        try {
          const { data: prot } = await pbrOctokit.rest.repos.getBranchProtection({ owner: pbrOrg, repo, branch: pbrDefaultBranch });
          if (prot.required_pull_request_reviews?.required_approving_review_count) {
            requiredReviews = Math.max(requiredReviews, prot.required_pull_request_reviews.required_approving_review_count);
          }
        } catch(e) {}
        
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
        } catch(e) {}

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

            if (bypassCount > 0) {
              results.push({
                repo,
                bypasses: bypassCount,
                reason: `${bypassCount} out of last ${prs.length} PRs bypassed the ${requiredReviews} reviewers requirement`,
                score: bypassCount // we will use this to sort later
              });
            }
          } catch(e) {}
        }
      }
      
      // Sort by bypass count descending
      results.sort((a, b) => b.score - a.score);
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

      for (const [u, repos] of userAccessMap.entries()) {
        if (repos.length >= 2) {
          try {
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
            
            const { data: searchData } = await dormOctokit.rest.search.commits({
              q: `author:${u} org:${dormOrg} committer-date:>=${sixMonthsAgo.toISOString().split('T')[0]}`
            });

            if (searchData.total_count === 0) {
              results.push({
                user: u,
                reason: `Dormant high-privilege account`,
                details: `Admin of ${repos.length} repos, but 0 commits in the org in the last 6 months`,
                adminRepos: repos.length
              });
            }
          } catch(e) {}
        }
      }
      break;
    }

    default:
      throw new Error("Unknown query type");
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
