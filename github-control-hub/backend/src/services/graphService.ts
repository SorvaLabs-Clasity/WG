import { docClient, usesDynamo, tableName, ScanCommand } from "../utils/dynamo";
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

export async function evaluateSecurityQuery(q: string, param?: string, advanced?: any, userToken?: string) {
  let allEdges: any[] = [];
  if (usesDynamo()) {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName("GRAPH_EDGES_TABLE"),
      })
    );
    allEdges = result.Items || [];
  } else {
    allEdges = loadLocalEdges();
  }

  const results: any[] = [];

  switch (q) {
    case "repos-dependent-on":
      if (!param) throw new Error("Missing 'param' for dependency name");
      for (const edge of allEdges) {
        if (edge.type === "has_vulnerable_dependency" && edge.sk === `DEPENDENCY#${param}`) {
          results.push({
            repo: edge.pk.replace("REPO#", ""),
            reason: `Depends on ${param} (${edge.metadata?.severity || "unknown"} severity)`
          });
        }
      }
      break;

    case "repos-deploying-to-prod":
      for (const edge of allEdges) {
        if (edge.type === "uses_workflow") {
          const wfName = edge.sk.replace("WORKFLOW#", "").toLowerCase();
          if (wfName.includes("prod") || wfName.includes("deploy") || wfName.includes("release")) {
            results.push({
              repo: edge.pk.replace("REPO#", ""),
              reason: `Uses workflow: ${wfName}`
            });
          }
        }
      }
      break;

    case "repos-with-outside-admins":
      for (const edge of allEdges) {
        if (edge.type === "has_collaborator" && edge.metadata?.role === "admin") {
          results.push({
            repo: edge.pk.replace("REPO#", ""),
            reason: `User ${edge.sk.replace("USER#", "")} has direct admin access`
          });
        }
      }
      break;

    case "highly-privileged-users":
      const userAccessMap = new Map<string, string[]>();
      for (const edge of allEdges) {
        if (edge.type === "collaborates_on" && ["admin", "write", "maintain"].includes(edge.metadata?.role)) {
          const user = edge.pk.replace("USER#", "");
          if (!userAccessMap.has(user)) userAccessMap.set(user, []);
          userAccessMap.get(user)!.push(edge.sk.replace("REPO#", ""));
        }
      }
      const threshold = parseInt(param as string) || 3;
      for (const [user, repos] of userAccessMap.entries()) {
        if (repos.length >= threshold) {
          results.push({
            user,
            reason: `Has direct write/admin access to ${repos.length} repos`,
            details: repos.slice(0, 5).join(", ") + (repos.length > 5 ? "..." : "")
          });
        }
      }
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

    case "repos-with-critical-vulns":
      for (const edge of allEdges) {
        if (edge.type === "has_vulnerable_dependency" && edge.metadata?.severity === "critical") {
          results.push({
            repo: edge.pk.replace("REPO#", ""),
            reason: `Critical vulnerability in ${edge.sk.replace("DEPENDENCY#", "")}`
          });
        }
      }
      break;
      
    case "repos-missing-branch":
      if (!param) throw new Error("Missing 'param' for branch name");
      const reposWithBranch = new Set();
      const allReposForBranch = new Set();
      for (const edge of allEdges) {
        if (edge.pk.startsWith("REPO#")) allReposForBranch.add(edge.pk);
        if (edge.type === "has_branch" && edge.sk === `BRANCH#${param}`) {
          reposWithBranch.add(edge.pk);
        }
      }
      for (const repo of allReposForBranch) {
        if (!reposWithBranch.has(repo)) {
          results.push({
            repo: (repo as string).replace("REPO#", ""),
            reason: `Missing branch: ${param}`
          });
        }
      }
      break;

    case "repos-with-unprotected-branch":
      if (!param) throw new Error("Missing 'param' for branch name");
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.sk === `BRANCH#${param}` && edge.metadata?.protected === false) {
          results.push({
            repo: edge.pk.replace("REPO#", ""),
            reason: `Branch '${param}' exists but is NOT protected`
          });
        }
      }
      break;

    case "repos-with-branch":
      if (!param) throw new Error("Missing 'param' for branch name");
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.sk === `BRANCH#${param}`) {
          results.push({
            repo: edge.pk.replace("REPO#", ""),
            reason: `Has branch: ${param}`
          });
        }
      }
      break;

    case "repos-with-branch-rules": {
      if (!param) throw new Error("Missing 'param' for branch name");
      const reqProtType = advanced?.protectionType as string || "any";
      const requirePr = advanced?.requirePr === true || advanced?.requirePr === "true";
      const requireStatusChecks = advanced?.requireStatusChecks === true || advanced?.requireStatusChecks === "true";
      const enforceAdmins = advanced?.enforceAdmins === true || advanced?.enforceAdmins === "true";

      const reposToCheck = [];
      for (const edge of allEdges) {
        if (edge.type === "has_branch" && edge.sk === `BRANCH#${param}`) {
           reposToCheck.push(edge.pk.replace("REPO#", ""));
        }
      }

      // Live fetch to determine specific rules
      const token = userToken || process.env.SYSTEM_GITHUB_TOKEN;
      if (!token) throw new Error("Authentication required for live rule evaluation");
      const { Octokit } = await import("octokit");
      const { getOrg } = await import("../github/client");
      const octokit = new Octokit({ auth: token });
      const org = getOrg();

      for (const repo of reposToCheck) {
        let hasClassic = false;
        let hasRuleset = false;
        let prFound = false;
        let statusChecksFound = false;
        let adminsFound = false;

        try {
          const { data: prot } = await octokit.rest.repos.getBranchProtection({ owner: org, repo, branch: param });
          hasClassic = true;
          if (prot.required_pull_request_reviews) prFound = true;
          if (prot.required_status_checks) statusChecksFound = true;
          if (prot.enforce_admins?.enabled) adminsFound = true;
        } catch (e: any) {
          // 404 means no classic protection
        }

        try {
          const { data: rulesets } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", { owner: org, repo });
          for (const rs of rulesets) {
            if (rs.target === "branch") {
              const { data: rsDetails } = await octokit.request("GET /repos/{owner}/{repo}/rulesets/{ruleset_id}", {
                owner: org, repo, ruleset_id: rs.id
              });
              
              let applies = false;
              const refs = rsDetails.conditions?.ref_name?.include || [];
              if (refs.includes(`refs/heads/${param}`) || refs.some((r: string) => r.includes(param))) {
                applies = true;
              } else if (refs.includes("~DEFAULT_BRANCH") && param === "main") {
                applies = true;
              }

              if (applies) {
                hasRuleset = true;
                const rules = rsDetails.rules || [];
                if (rules.some((r: any) => r.type === "pull_request")) prFound = true;
                if (rules.some((r: any) => r.type === "required_status_checks")) statusChecksFound = true;
              }
            }
          }
        } catch (e) { }

        let match = false;
        let matchedType = "";
        
        if (reqProtType === "classic" && hasClassic) { match = true; matchedType = "Classic"; }
        if (reqProtType === "ruleset" && hasRuleset) { match = true; matchedType = "Ruleset"; }
        if (reqProtType === "any" && (hasClassic || hasRuleset)) { match = true; matchedType = hasRuleset ? "Ruleset" : "Classic"; }

        if (match) {
          if (requirePr && !prFound) match = false;
          if (requireStatusChecks && !statusChecksFound) match = false;
          if (enforceAdmins && !adminsFound && matchedType === "Classic") match = false;
        }

        if (match) {
          const ruleReasons = [];
          if (requirePr) ruleReasons.push("PRs");
          if (requireStatusChecks) ruleReasons.push("Status Checks");
          if (enforceAdmins) ruleReasons.push("Enforce Admins");

          results.push({
            repo,
            reason: `Protected by ${matchedType} Rules${ruleReasons.length ? ` requiring: ${ruleReasons.join(", ")}` : ''}`
          });
        }
      }
      break;
    }

    case "stale-branch-protections": {
      const sbpToken = userToken || process.env.SYSTEM_GITHUB_TOKEN;
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
        
        try {
          const { data: prot } = await sbpOctokit.rest.repos.getBranchProtection({ owner: sbpOrg, repo, branch: "main" });
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
      const pbrToken = userToken || process.env.SYSTEM_GITHUB_TOKEN;
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
        
        try {
          const { data: prot } = await pbrOctokit.rest.repos.getBranchProtection({ owner: pbrOrg, repo, branch: "main" });
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

    case "users-without-mfa": {
      const mfaToken = userToken || process.env.SYSTEM_GITHUB_TOKEN;
      if (!mfaToken) throw new Error("Authentication required for live evaluation");
      const { Octokit: MfaOctokit } = await import("octokit");
      const { getOrg: mfaGetOrg } = await import("../github/client");
      const mfaOctokit = new MfaOctokit({ auth: mfaToken });
      const mfaOrg = mfaGetOrg();

      let mfaDisabledUsers: string[] = [];
      try {
        const { data: members } = await mfaOctokit.rest.orgs.listMembers({
          org: mfaOrg,
          filter: "2fa_disabled"
        });
        mfaDisabledUsers = members.map(m => m.login);
      } catch (e: any) {
        console.warn("Failed to fetch 2FA disabled members. Token might lack admin:org scope.", e.message);
      }

      for (const userLogin of mfaDisabledUsers) {
        let adminRepos = 0;
        let writeRepos = 0;
        let prodRepos = 0;

        for (const edge of allEdges) {
          if (edge.type === "collaborates_on" && edge.pk === `USER#${userLogin}`) {
            const repo = edge.sk.replace("REPO#", "");
            if (edge.metadata?.role === "admin") adminRepos++;
            if (edge.metadata?.role === "write") writeRepos++;
            
            const isProd = allEdges.some(e => e.pk === `REPO#${repo}` && e.type === "uses_workflow" && (e.sk.toLowerCase().includes("prod") || e.sk.toLowerCase().includes("deploy") || e.sk.toLowerCase().includes("release")));
            if (isProd) prodRepos++;
          }
        }

        results.push({
          user: userLogin,
          reason: `No MFA enabled`,
          details: `Admin Repos: ${adminRepos}, Write Repos: ${writeRepos}, Prod Repos: ${prodRepos}`,
          adminRepos,
          writeRepos,
          prodRepos
        });
      }
      
      results.sort((a, b) => (b.adminRepos * 2 + b.prodRepos * 3 + b.writeRepos) - (a.adminRepos * 2 + a.prodRepos * 3 + a.writeRepos));
      break;
    }

    case "dormant-privileged-users": {
      const dormToken = userToken || process.env.SYSTEM_GITHUB_TOKEN;
      if (!dormToken) throw new Error("Authentication required for live evaluation");
      const { Octokit: DormOctokit } = await import("octokit");
      const { getOrg: dormGetOrg } = await import("../github/client");
      const dormOctokit = new DormOctokit({ auth: dormToken });
      const dormOrg = dormGetOrg();

      const userAccessMap = new Map<string, string[]>();
      for (const edge of allEdges) {
        if (edge.type === "collaborates_on" && ["admin", "maintain"].includes(edge.metadata?.role)) {
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
