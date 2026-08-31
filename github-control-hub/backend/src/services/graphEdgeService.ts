import { Octokit } from "octokit";
import { createOctokit } from "../github/client";
import { docClient, hasTable, tableName, PutCommand, DeleteCommand, QueryCommand, batchWrite } from "../utils/dynamo";

import { bumpGraphVersion } from "./graphVersion";

const TABLE = () => tableName("GRAPH_EDGES_TABLE");

// Every write bumps the version. Bumped *after* the write lands, so a counter
// that moved is a promise the graph really did change; the other order would
// let a failed write invalidate every cached copy for nothing.
async function putEdge(pk: string, sk: string, type: string, metadata?: Record<string, any>) {
  if (!hasTable("GRAPH_EDGES_TABLE")) return;
  await docClient.send(new PutCommand({ TableName: TABLE(), Item: { pk, sk, type, metadata } }));
  await bumpGraphVersion();
}

async function deleteEdge(pk: string, sk: string) {
  if (!hasTable("GRAPH_EDGES_TABLE")) return;
  await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { pk, sk } }));
  await bumpGraphVersion();
}

async function putEdgesBatch(edges: Array<{ pk: string; sk: string; type: string; metadata?: Record<string, any> }>) {
  if (!hasTable("GRAPH_EDGES_TABLE") || edges.length === 0) return;
  // Deduplicated across the whole set rather than inside each batch of 25.
  // The same edge produced twice in different batches was written twice, and
  // DynamoDB rejects a batch containing two writes to one key outright, so a
  // duplicate straddling a boundary was a silent double write, and one landing
  // inside a batch was a hard failure.
  const unique = new Map<string, (typeof edges)[0]>();
  for (const e of edges) unique.set(`${e.pk}\u0000${e.sk}`, e);
  // batchWrite retries what DynamoDB declines. The loop this replaces read the
  // response and threw it away, so a throttled write was an edge that never
  // existed and a repository that looked like it had no branches.
  await batchWrite(TABLE(), [...unique.values()].map(item => ({ PutRequest: { Item: item } })));
  await bumpGraphVersion();
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
 * Merge fields into a repository's `repo_meta` edge.
 *
 * Read-modify-write rather than a plain put, because this edge carries a dozen
 * fields the rebuild collected, visibility, archived, fork, last push, the
 * scanning switches, and a webhook only ever knows about one of them.
 * Overwriting would drop the rest and leave every check that reads them
 * answering from a blank.
 *
 * A repository the rebuild has never seen is skipped rather than created from
 * one field. A partial `repo_meta` is worse than none: "not collected" and
 * "collected and empty" are different answers, and the checks that read this
 * treat a missing edge as the former.
 */
export async function patchRepoMeta(repo: string, patch: Record<string, any>) {
  if (!hasTable("GRAPH_EDGES_TABLE")) return;
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const key = { pk: `REPO#${repo}`, sk: "META#repo" };

  const existing: any = await docClient.send(new GetCommand({ TableName: TABLE(), Key: key }));
  if (!existing?.Item) return;

  await putEdge(key.pk, key.sk, "repo_meta", { ...(existing.Item.metadata ?? {}), ...patch });
}

/**
 * A team gaining or losing a repository.
 *
 * Both directions, because the graph is walked from either end: `owns_repo`
 * answers "what does this team have", `owned_by_team` answers "who owns this
 * repository", which is the one `unowned-repos` reads.
 */
export async function addTeamRepoEdge(team: string, repo: string, permission: string) {
  await putEdge(`TEAM#${team}`, `REPO#${repo}`, "owns_repo", { permission });
  await putEdge(`REPO#${repo}`, `TEAM#${team}`, "owned_by_team", { permission });
}

export async function removeTeamRepoEdge(team: string, repo: string) {
  await deleteEdge(`TEAM#${team}`, `REPO#${repo}`);
  await deleteEdge(`REPO#${repo}`, `TEAM#${team}`);
}

/** A person joining or leaving a team. `has_member` is what `empty-teams` reads. */
export async function addTeamMemberEdge(team: string, user: string) {
  await putEdge(`USER#${user}`, `TEAM#${team}`, "member_of");
  await putEdge(`TEAM#${team}`, `USER#${user}`, "has_member");
}

export async function removeTeamMemberEdge(team: string, user: string) {
  await deleteEdge(`USER#${user}`, `TEAM#${team}`);
  await deleteEdge(`TEAM#${team}`, `USER#${user}`);
}

/**
 * A vulnerable dependency appearing or clearing on a repository.
 *
 * Keyed on the package name, matching the rebuild, so a second advisory for
 * the same package updates the edge rather than adding another. The severity
 * shown is whichever alert most recently arrived, which is also what the
 * rebuild would have written had it run at that moment.
 */
export async function addVulnerableDependencyEdge(
  repo: string, dependency: string, severity: string, alertNumber?: number,
) {
  await putEdge(`REPO#${repo}`, `DEPENDENCY#${dependency}`, "has_vulnerable_dependency", {
    severity,
    ...(alertNumber !== undefined ? { alert_number: alertNumber } : {}),
  });
}

export async function removeVulnerableDependencyEdge(repo: string, dependency: string) {
  await deleteEdge(`REPO#${repo}`, `DEPENDENCY#${dependency}`);
}

/**
 * Fetch all edges for a single newly-created repo and write them.
 * Covers: branches, collaborators, workflows, dependabot alerts.
 */
export async function addRepoEdges(token: string, org: string, repoName: string) {
  const octokit = createOctokit(token);
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

/**
 * Everything the graph holds about one repository, removed.
 *
 * Left behind, a deleted repository's `repo_meta`, collaborators, branches and
 * team links keep every check reporting something that no longer exists, until
 * the next full rebuild clears the table, with a refresh button that cannot
 * help because the rows it re-reads are still there.
 *
 * The light pass does not cover it: it prunes inside teams it has just read,
 * and a vanished repository is under no team it reads.
 *
 * Both directions are removed. An edge from a team or user *to* this repository
 * lives under that partition key, so deleting the repository's own would leave
 * the other half dangling.
 */
export async function removeAllRepoEdges(repo: string): Promise<number> {
  if (!hasTable("GRAPH_EDGES_TABLE")) return 0;
  const pk = `REPO#${repo}`;

  const own: Array<{ pk: string; sk: string }> = [];
  let cursor: any;
  do {
    const page: any = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": pk },
      ProjectionExpression: "pk, sk",
      ExclusiveStartKey: cursor,
    }));
    for (const it of page.Items ?? []) own.push({ pk: it.pk, sk: it.sk });
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  // The mirrored half: whatever pointed at this repository from a team or a
  // user. `sk` on those rows is this repository's key, and `pk` is theirs.
  const mirrored = own
    .filter(e => e.sk.startsWith("TEAM#") || e.sk.startsWith("USER#"))
    .map(e => ({ pk: e.sk, sk: pk }));

  const all = [...own, ...mirrored];
  if (all.length === 0) return 0;

  await batchWrite(TABLE(), all.map(k => ({ DeleteRequest: { Key: k } })));
  await bumpGraphVersion();
  console.log(`[Graph] Removed ${all.length} edges for deleted repository ${repo}`);
  return all.length;
}
