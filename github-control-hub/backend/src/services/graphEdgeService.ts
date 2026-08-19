import { Octokit } from "octokit";
import { docClient, usesDynamo, tableName, PutCommand, DeleteCommand, batchWrite } from "../utils/dynamo";

const TABLE = () => tableName("GRAPH_EDGES_TABLE");

async function putEdge(pk: string, sk: string, type: string, metadata?: Record<string, any>) {
  if (!usesDynamo()) return;
  await docClient.send(new PutCommand({ TableName: TABLE(), Item: { pk, sk, type, metadata } }));
}

async function deleteEdge(pk: string, sk: string) {
  if (!usesDynamo()) return;
  await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { pk, sk } }));
}

async function putEdgesBatch(edges: Array<{ pk: string; sk: string; type: string; metadata?: Record<string, any> }>) {
  if (!usesDynamo() || edges.length === 0) return;
  // Deduplicated across the whole set rather than inside each batch of 25.
  // The same edge produced twice in different batches was written twice, and
  // DynamoDB rejects a batch containing two writes to one key outright — so a
  // duplicate straddling a boundary was a silent double write, and one landing
  // inside a batch was a hard failure.
  const unique = new Map<string, (typeof edges)[0]>();
  for (const e of edges) unique.set(`${e.pk}\u0000${e.sk}`, e);
  // batchWrite retries what DynamoDB declines. The loop this replaces read the
  // response and threw it away, so a throttled write was an edge that never
  // existed and a repository that looked like it had no branches.
  await batchWrite(TABLE(), [...unique.values()].map(item => ({ PutRequest: { Item: item } })));
}

export async function addBranchEdge(repo: string, branch: string, isProtected: boolean) {
  await putEdge(`REPO#${repo}`, `BRANCH#${branch}`, "has_branch", { protected: isProtected });
}

export async function removeBranchEdge(repo: string, branch: string) {
  await deleteEdge(`REPO#${repo}`, `BRANCH#${branch}`);
}

export async function updateBranchProtection(repo: string, branch: string, isProtected: boolean) {
  await putEdge(`REPO#${repo}`, `BRANCH#${branch}`, "has_branch", { protected: isProtected });
}

export async function addCollaboratorEdge(repo: string, user: string, role: string) {
  await putEdge(`REPO#${repo}`, `USER#${user}`, "has_collaborator", { role });
  await putEdge(`USER#${user}`, `REPO#${repo}`, "collaborates_on", { role });
}

export async function removeCollaboratorEdge(repo: string, user: string) {
  await deleteEdge(`REPO#${repo}`, `USER#${user}`);
  await deleteEdge(`USER#${user}`, `REPO#${repo}`);
}

/**
 * Fetch all edges for a single newly-created repo and write them.
 * Covers: branches, collaborators, workflows, dependabot alerts.
 */
export async function addRepoEdges(token: string, org: string, repoName: string) {
  const octokit = new Octokit({ auth: token });
  const repoId = `REPO#${repoName}`;
  const edges: Array<{ pk: string; sk: string; type: string; metadata?: Record<string, any> }> = [];

  try {
    let page = 1;
    while (true) {
      const { data: branches } = await octokit.rest.repos.listBranches({ owner: org, repo: repoName, per_page: 100, page });
      if (branches.length === 0) break;
      for (const b of branches) {
        edges.push({ pk: repoId, sk: `BRANCH#${b.name}`, type: "has_branch", metadata: { protected: b.protected } });
      }
      if (branches.length < 100) break;
      page++;
    }
  } catch (err: any) {
    if (err.status !== 403 && err.status !== 404 && err.status !== 409)
      console.warn(`[GraphEdge] Failed to fetch branches for ${repoName}:`, err.message);
  }

  try {
    let page = 1;
    while (true) {
      const { data: collaborators } = await octokit.rest.repos.listCollaborators({ owner: org, repo: repoName, affiliation: "direct", per_page: 100, page });
      if (collaborators.length === 0) break;
      for (const c of collaborators) {
        if (c?.login) {
          edges.push({ pk: repoId, sk: `USER#${c.login}`, type: "has_collaborator", metadata: { role: c.role_name } });
          edges.push({ pk: `USER#${c.login}`, sk: repoId, type: "collaborates_on", metadata: { role: c.role_name } });
        }
      }
      if (collaborators.length < 100) break;
      page++;
    }
  } catch (err: any) {
    if (err.status !== 403 && err.status !== 404)
      console.warn(`[GraphEdge] Failed to fetch collaborators for ${repoName}:`, err.message);
  }

  try {
    const { data: workflows } = await octokit.rest.actions.listRepoWorkflows({ owner: org, repo: repoName, per_page: 100 });
    for (const wf of workflows.workflows) {
      edges.push({ pk: repoId, sk: `WORKFLOW#${wf.name}`, type: "uses_workflow", metadata: { path: wf.path, state: wf.state } });
    }
  } catch (err: any) {
    if (err.status !== 403 && err.status !== 404)
      console.warn(`[GraphEdge] Failed to fetch workflows for ${repoName}:`, err.message);
  }

  try {
    const { data: alerts } = await octokit.rest.dependabot.listAlertsForRepo({ owner: org, repo: repoName, state: "open", per_page: 100 });
    for (const alert of alerts) {
      const depName = alert.security_vulnerability?.package?.name || alert.security_advisory?.summary || "unknown";
      const severity = alert.security_vulnerability?.severity || alert.security_advisory?.severity || "low";
      edges.push({ pk: repoId, sk: `DEPENDENCY#${depName}`, type: "has_vulnerable_dependency", metadata: { severity, alert_number: alert.number } });
    }
  } catch (err: any) {
    if (err.status !== 403 && err.status !== 404 && err.status !== 400)
      console.warn(`[GraphEdge] Failed to fetch dependabot alerts for ${repoName}:`, err.message);
  }

  console.log(`[GraphEdge] Writing ${edges.length} edges for new repo "${repoName}"`);
  await putEdgesBatch(edges);
}
