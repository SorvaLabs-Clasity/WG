import { Octokit } from "octokit";
import { getOrg, getSystemTokenAsync } from "../github/client";
import { docClient, usesDynamo, tableName, PutCommand, BatchWriteCommand, ScanCommand, DeleteCommand } from "../utils/dynamo";
import { refreshAll } from "../services/complianceCacheService";

interface GraphEdge {
  pk: string;
  sk: string;
  type: string;
  metadata?: any;
}

export async function aggregateGraphData(fallbackToken?: string) {
  const token = await getSystemTokenAsync() || fallbackToken;
  if (!token) {
    console.warn("No GitHub token available, skipping graph aggregation.");
    return;
  }

  const octokit = new Octokit({ auth: token });
  const org = getOrg();
  const edges: GraphEdge[] = [];
  const edgesTable = usesDynamo() ? tableName("GRAPH_EDGES_TABLE") : "";

  console.log(`[GraphAggregator] Starting aggregation for org: ${org}`);

  try {
    // 1. Fetch Repositories
    const repos: any[] = [];
    let repoPage = 1;
    while (true) {
      const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page: repoPage });
      if (data.length === 0) break;
      repos.push(...data);
      if (data.length < 100) break;
      repoPage++;
    }
    console.log(`[GraphAggregator] Fetched ${repos.length} repositories`);

    // 2. Fetch Teams and Members
    const teams: any[] = [];
    let teamPage = 1;
    while (true) {
      const { data } = await octokit.rest.teams.list({ org, per_page: 100, page: teamPage });
      if (data.length === 0) break;
      teams.push(...data);
      if (data.length < 100) break;
      teamPage++;
    }
    console.log(`[GraphAggregator] Fetched ${teams.length} teams`);

    // Org owners are admin on every repository by virtue of the role. Recorded
    // so queries can ask "who has admin that ownership does not explain",
    // rather than reporting the owner against all 356 repositories.
    const orgOwners = new Set<string>();
    try {
      const { data } = await octokit.rest.orgs.listMembers({ org, role: "admin", per_page: 100 });
      for (const m of data) if (m?.login) orgOwners.add(m.login);
    } catch {
      // Without this the worst case is a grant recorded as direct rather than
      // as ownership — a wrong label, not a missing edge.
    }

    /** repo name -> logins that reach it through a team. */
    const viaTeam = new Map<string, Set<string>>();

    // TEAM -> REPO edges & USER -> TEAM edges
    for (const team of teams) {
      const teamId = `TEAM#${team.slug}`;
      const teamRepoNames: string[] = [];
      const teamMemberLogins: string[] = [];

      // Get repos for team
      try {
        let tpPage = 1;
        while (true) {
          const { data: teamRepos } = await octokit.rest.teams.listReposInOrg({ org, team_slug: team.slug, per_page: 100, page: tpPage });
          if (teamRepos.length === 0) break;
          for (const tr of teamRepos) {
            if (!viaTeam.has(tr.name)) viaTeam.set(tr.name, new Set());
            teamRepoNames.push(tr.name);
            edges.push({
              pk: teamId,
              sk: `REPO#${tr.name}`,
              type: "owns_repo",
              metadata: { permission: tr.role_name || "read" }
            });
            edges.push({
              pk: `REPO#${tr.name}`,
              sk: teamId,
              type: "owned_by_team",
              metadata: { permission: tr.role_name || "read" }
            });
          }
          if (teamRepos.length < 100) break;
          tpPage++;
        }
      } catch (err) {
        console.warn(`[GraphAggregator] Failed to fetch repos for team ${team.slug}`);
      }

      // Get members for team
      try {
        let tmPage = 1;
        while (true) {
          const { data: members } = await octokit.rest.teams.listMembersInOrg({ org, team_slug: team.slug, per_page: 100, page: tmPage });
          if (members.length === 0) break;
          for (const member of members) {
            if (member && member.login) {
              teamMemberLogins.push(member.login);
              edges.push({
                pk: `USER#${member.login}`,
                sk: teamId,
                type: "member_of",
              });
              edges.push({
                pk: teamId,
                sk: `USER#${member.login}`,
                type: "has_member",
              });
            }
          }
          if (members.length < 100) break;
          tmPage++;
        }
      } catch (err) {
        console.warn(`[GraphAggregator] Failed to fetch members for team ${team.slug}`);
      }

      for (const repoName of teamRepoNames) {
        const set = viaTeam.get(repoName)!;
        for (const login of teamMemberLogins) set.add(login);
      }
    }

    // 3. Repo details: Collaborators, Workflows, Dependabot
    for (const repo of repos) {
      const repoId = `REPO#${repo.name}`;

      // The repository's own facts, which listForOrg already returned and this
      // loop used to throw away. Keeping them is one edge per repository and no
      // additional request, and it lets questions about visibility, archival
      // and last activity be answered from the graph rather than by fetching
      // every repository again at query time.
      edges.push({
        pk: repoId,
        sk: "META#repo",
        type: "repo_meta",
        metadata: {
          visibility: repo.visibility ?? (repo.private ? "private" : "public"),
          archived: !!repo.archived,
          fork: !!repo.fork,
          pushedAt: repo.pushed_at ?? null,
          defaultBranch: repo.default_branch ?? "main",
          // Every one of these is off across the sampled organisation, and each
          // is a control an auditor asks about by name.
          secretScanning: repo.security_and_analysis?.secret_scanning?.status ?? "unknown",
          pushProtection: repo.security_and_analysis?.secret_scanning_push_protection?.status ?? "unknown",
        },
      });

      // Who can write to this repository, and how they came by it.
      //
      // This asked for affiliation "direct", meaning only people granted access
      // to the repository individually. Almost nobody gets access that way —
      // it arrives through org membership or a team — so the graph recorded
      // one collaborator across the whole organisation and every question
      // about people returned nothing.
      //
      // Two deliberate narrowings keep that from turning into noise:
      //
      //   Only admin, write and maintain are recorded. Read is what the org
      //   default grants everyone on everything, so recording it would add one
      //   edge per member per repository — hundreds of thousands at a real
      //   company — and no query asks about read.
      //
      //   Each edge carries how the access was obtained. Without it an org
      //   owner is admin on every repository and floods every result; with it
      //   a query can ask the useful question, which is who has admin that
      //   ownership and team membership do not already explain.
      try {
        const PRIVILEGED = ["admin", "write", "maintain"];
        const teamMembersHere = viaTeam.get(repo.name);
        let colPage = 1;
        while (true) {
          const { data: collaborators } = await octokit.rest.repos.listCollaborators({ owner: org, repo: repo.name, affiliation: "all", per_page: 100, page: colPage });
          if (collaborators.length === 0) break;
          for (const collab of collaborators) {
            if (!collab?.login) continue;
            const role = collab.role_name ?? "read";
            if (!PRIVILEGED.includes(role)) continue;

            const source = orgOwners.has(collab.login) ? "org_owner"
              : teamMembersHere?.has(collab.login) ? "team"
              : "direct";

            const metadata = { role, source };
            edges.push({ pk: `USER#${collab.login}`, sk: repoId, type: "collaborates_on", metadata });
            edges.push({ pk: repoId, sk: `USER#${collab.login}`, type: "has_collaborator", metadata });
          }
          if (collaborators.length < 100) break;
          colPage++;
        }
      } catch (err: any) {
         if (err.status !== 403 && err.status !== 404) console.warn(`[GraphAggregator] Failed to fetch collaborators for ${repo.name}`);
      }

      // Workflows
      try {
        const { data: workflows } = await octokit.rest.actions.listRepoWorkflows({ owner: org, repo: repo.name, per_page: 100 });
        for (const wf of workflows.workflows) {
          edges.push({
            pk: repoId,
            sk: `WORKFLOW#${wf.name}`,
            type: "uses_workflow",
            metadata: { path: wf.path, state: wf.state }
          });
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404) console.warn(`[GraphAggregator] Failed to fetch workflows for ${repo.name}`);
      }

      // Dependabot Alerts (Dependencies)
      try {
        const { data: alerts } = await octokit.rest.dependabot.listAlertsForRepo({ owner: org, repo: repo.name, state: "open", per_page: 100 });
        for (const alert of alerts) {
          const depName = alert.security_vulnerability?.package?.name || alert.security_advisory?.summary || "unknown";
          const severity = alert.security_vulnerability?.severity || alert.security_advisory?.severity || "low";
          edges.push({
            pk: repoId,
            sk: `DEPENDENCY#${depName}`,
            type: "has_vulnerable_dependency",
            metadata: { severity, alert_number: alert.number }
          });
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404 && err.status !== 400) console.warn(`[GraphAggregator] Failed to fetch dependabot alerts for ${repo.name}`);
      }

      // Branches
      try {
        let branchPage = 1;
        while (true) {
          const { data: branches } = await octokit.rest.repos.listBranches({ owner: org, repo: repo.name, per_page: 100, page: branchPage });
          if (branches.length === 0) break;
          for (const branch of branches) {
            edges.push({
              pk: repoId,
              sk: `BRANCH#${branch.name}`,
              type: "has_branch",
              metadata: { protected: branch.protected, default: branch.name === repo.default_branch }
            });
          }
          if (branches.length < 100) break;
          branchPage++;
        }
      } catch (err: any) {
        if (err.status !== 403 && err.status !== 404 && err.status !== 409) console.warn(`[GraphAggregator] Failed to fetch branches for ${repo.name}`);
      }
    }

    console.log(`[GraphAggregator] Generated ${edges.length} graph edges. Starting database sync...`);

    // Write edges to database
    if (usesDynamo()) {
      // For a full refresh, it's often easiest to truncate and rewrite, or use TTL.
      // Since this runs every 6 hours, we'll scan and delete old edges first to avoid orphans.
      console.log(`[GraphAggregator] Clearing old graph edges...`);
      try {
        const scanRes = await docClient.send(new ScanCommand({ TableName: edgesTable, ProjectionExpression: "pk, sk" }));
        const oldItems = scanRes.Items || [];
        
        // Delete in batches of 25
        for (let i = 0; i < oldItems.length; i += 25) {
          const batch = oldItems.slice(i, i + 25);
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [edgesTable]: batch.map(item => ({
                DeleteRequest: {
                  Key: { pk: item.pk, sk: item.sk }
                }
              }))
            }
          }));
        }
      } catch (e) {
        console.error(`[GraphAggregator] Error clearing old edges:`, e);
      }

      // Write new edges in batches of 25
      console.log(`[GraphAggregator] Writing new edges...`);
      for (let i = 0; i < edges.length; i += 25) {
        const batch = edges.slice(i, i + 25);
        
        // Remove duplicates within the batch just in case
        const uniqueBatchMap = new Map();
        for (const item of batch) {
          uniqueBatchMap.set(`${item.pk}::${item.sk}`, item);
        }
        const uniqueBatch = Array.from(uniqueBatchMap.values());

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [edgesTable]: uniqueBatch.map(item => ({
                PutRequest: {
                  Item: item
                }
              }))
            }
          }));
        } catch (e) {
           console.error(`[GraphAggregator] Error writing batch:`, e);
        }
      }
      console.log(`[GraphAggregator] DynamoDB sync complete.`);
    } else {
      // Fallback for local development if not using DynamoDB
      // We'll write to a JSON file in the backend/data directory
      const fs = require("fs");
      const path = require("path");
      const dataDir = path.join(__dirname, "../../data");
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(path.join(dataDir, "graph-edges.json"), JSON.stringify(edges, null, 2));
      console.log(`[GraphAggregator] Wrote edges to local JSON file.`);
    }

  } catch (error) {
    console.error(`[GraphAggregator] Fatal error during aggregation:`, error);
  }

  try {
    console.log(`[GraphAggregator] Refreshing compliance cache for all repos...`);
    const scores = await refreshAll(token);
    console.log(`[GraphAggregator] Compliance cache refreshed for ${scores.length} repos.`);
  } catch (err) {
    console.error(`[GraphAggregator] Compliance cache refresh failed:`, err);
  }
}