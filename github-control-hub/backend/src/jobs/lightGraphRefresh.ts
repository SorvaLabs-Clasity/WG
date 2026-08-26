import { Octokit } from "octokit";
import { getOrg, getSystemTokenAsync } from "../github/client";
import { docClient, tableName, QueryCommand, batchWrite } from "../utils/dynamo";

/**
 * The cheap half of the access graph, refreshed far more often than the rest.
 *
 * Six checks read edge types the full rebuild is the only writer of —
 * `public-repos`, `archived-repos-with-access`, `stale-repos`, `unowned-repos`,
 * `empty-teams` and `repos-dependent-on`. Webhooks now patch those as changes
 * arrive, but a webhook can be missed, arrive out of order, or not be sent at
 * all, and until this existed the only correction was six hours away.
 *
 * The striking part is the cost. The full rebuild is about four requests per
 * *repository* — twelve hundred for three hundred repos — and almost none of
 * that is what these six read:
 *
 *   repo_meta      already returned by the repository listing. No extra call.
 *   owned_by_team  two calls per team.
 *   has_member     included in those two.
 *
 * So a few hundred repositories and a few dozen teams costs under a hundred
 * requests, against fifteen thousand an hour. The expensive walk — every
 * repository's collaborators, branches, workflows and alerts — stays on six
 * hours, where it belongs.
 *
 * **This never clears the table.** The full rebuild does, and running that
 * often would be the expensive thing wearing a cheap hat. This upserts what it
 * reads and prunes only within the team it just walked, so an edge it is not
 * responsible for is never at risk.
 */

const TABLE = () => tableName("GRAPH_EDGES_TABLE");

type Edge = { pk: string; sk: string; type: string; metadata?: Record<string, any> };

/** Every edge stored under one partition key. Used to prune what has gone. */
async function edgesUnder(pk: string): Promise<Array<{ pk: string; sk: string }>> {
  const out: Array<{ pk: string; sk: string }> = [];
  let cursor: any;
  do {
    const page: any = await docClient.send(new QueryCommand({
      TableName: TABLE(),
      KeyConditionExpression: "pk = :p",
      ExpressionAttributeValues: { ":p": pk },
      ProjectionExpression: "pk, sk",
      ExclusiveStartKey: cursor,
    }));
    out.push(...(page.Items ?? []));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return out;
}

export interface LightRefreshResult {
  repos: number;
  teams: number;
  edgesWritten: number;
  edgesRemoved: number;
  requests: number;
  errors: string[];
}

export async function refreshLightEdges(fallbackToken?: string): Promise<LightRefreshResult> {
  const org = getOrg();
  const token = fallbackToken ?? await getSystemTokenAsync();
  const octokit = new Octokit({ auth: token });

  const result: LightRefreshResult = {
    repos: 0, teams: 0, edgesWritten: 0, edgesRemoved: 0, requests: 0, errors: [],
  };
  // Keyed to the table this pass writes, not to the unrelated flag.
  //
  // `usesDynamo()` reports whether ACTIVITY_TABLE is set. This runs in the
  // aggregator's Lambda, which is given GRAPH_EDGES_TABLE and never that one,
  // so the answer was always no and every thirty-minute pass returned here
  // having done nothing — in about fifty milliseconds, which is what the logs
  // showed and what nobody read as a failure.
  if (!process.env.GRAPH_EDGES_TABLE) {
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new Error(
        "[LightGraphRefresh] GRAPH_EDGES_TABLE is not set. Refusing to refresh "
        + "the graph with nowhere to put it.",
      );
    }
    return result;
  }

  const writes: Edge[] = [];
  const deletes: Array<{ pk: string; sk: string }> = [];

  // ── repositories ────────────────────────────────────────────────────
  //
  // `repo_meta` is built entirely from what the listing already returns, so
  // this whole section is three requests for three hundred repositories.
  const repos: any[] = [];
  try {
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page });
      result.requests++;
      if (data.length === 0) break;
      repos.push(...data);
      if (data.length < 100) break;
      page++;
    }
  } catch (err: any) {
    // Without the repository list there is nothing to write and nothing safe to
    // prune. Returning early beats writing half a picture.
    result.errors.push(`repositories: ${err?.message ?? err}`);
    return result;
  }

  for (const repo of repos) {
    writes.push({
      pk: `REPO#${repo.name}`,
      sk: "META#repo",
      type: "repo_meta",
      metadata: {
        visibility: repo.visibility ?? (repo.private ? "private" : "public"),
        archived: !!repo.archived,
        fork: !!repo.fork,
        pushedAt: repo.pushed_at ?? null,
        defaultBranch: repo.default_branch ?? "main",
        secretScanning: repo.security_and_analysis?.secret_scanning?.status ?? "unknown",
        pushProtection: repo.security_and_analysis?.secret_scanning_push_protection?.status ?? "unknown",
      },
    });
  }
  result.repos = repos.length;

  // ── teams ───────────────────────────────────────────────────────────
  const teams: any[] = [];
  try {
    let page = 1;
    while (true) {
      const { data } = await octokit.rest.teams.list({ org, per_page: 100, page });
      result.requests++;
      if (data.length === 0) break;
      teams.push(...data);
      if (data.length < 100) break;
      page++;
    }
  } catch (err: any) {
    result.errors.push(`teams: ${err?.message ?? err}`);
  }

  for (const team of teams) {
    const teamId = `TEAM#${team.slug}`;
    const wantedUnderTeam = new Set<string>();
    let readTeam = true;

    try {
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.teams.listReposInOrg({
          org, team_slug: team.slug, per_page: 100, page,
        });
        result.requests++;
        if (data.length === 0) break;
        for (const tr of data) {
          const permission = (tr as any).role_name || "read";
          writes.push({ pk: teamId, sk: `REPO#${tr.name}`, type: "owns_repo", metadata: { permission } });
          writes.push({ pk: `REPO#${tr.name}`, sk: teamId, type: "owned_by_team", metadata: { permission } });
          wantedUnderTeam.add(`REPO#${tr.name}`);
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (err: any) {
      readTeam = false;
      result.errors.push(`team ${team.slug} repos: ${err?.message ?? err}`);
    }

    try {
      let page = 1;
      while (true) {
        const { data } = await octokit.rest.teams.listMembersInOrg({
          org, team_slug: team.slug, per_page: 100, page,
        });
        result.requests++;
        if (data.length === 0) break;
        for (const m of data) {
          if (!m?.login) continue;
          writes.push({ pk: teamId, sk: `USER#${m.login}`, type: "has_member" });
          writes.push({ pk: `USER#${m.login}`, sk: teamId, type: "member_of" });
          wantedUnderTeam.add(`USER#${m.login}`);
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (err: any) {
      readTeam = false;
      result.errors.push(`team ${team.slug} members: ${err?.message ?? err}`);
    }

    // Prune only when both halves of this team were read.
    //
    // A partial read looks identical to a team that lost every repository and
    // every member, and acting on it would delete the edges rather than report
    // that they could not be checked — the same failure as showing an empty
    // result for a check that could not run.
    if (readTeam) {
      for (const existing of await edgesUnder(teamId)) {
        if (!wantedUnderTeam.has(existing.sk)) {
          deletes.push(existing);
          // The mirrored direction, which lives under the other end's key.
          deletes.push({ pk: existing.sk, sk: teamId });
        }
      }
    }
  }
  result.teams = teams.length;

  // ── write ───────────────────────────────────────────────────────────
  if (writes.length) {
    const unique = new Map<string, Edge>();
    for (const e of writes) unique.set(`${e.pk}\u0000${e.sk}`, e);
    await batchWrite(TABLE(), [...unique.values()].map(Item => ({ PutRequest: { Item } })));
    result.edgesWritten = unique.size;
  }
  if (deletes.length) {
    const unique = new Map<string, { pk: string; sk: string }>();
    for (const d of deletes) unique.set(`${d.pk}\u0000${d.sk}`, d);
    await batchWrite(TABLE(), [...unique.values()].map(Key => ({ DeleteRequest: { Key } })));
    result.edgesRemoved = unique.size;
  }

  return result;
}
