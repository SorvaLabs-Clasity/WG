import { Octokit } from "octokit";
import { docClient, usesDynamo, tableName, PutCommand, ScanCommand } from "../utils/dynamo";
import { createOctokit, getOrg } from "../github/client";
import { calculateRepoCompliance, RepoComplianceScore } from "./complianceService";

const TABLE = () => tableName("COMPLIANCE_CACHE_TABLE");

let memCache: RepoComplianceScore[] = [];

export async function getCachedScores(): Promise<RepoComplianceScore[]> {
  if (!usesDynamo()) return memCache;

  const items: RepoComplianceScore[] = [];
  let lastKey: any = undefined;
  do {
    const result: any = await docClient.send(
      new ScanCommand({ TableName: TABLE(), ExclusiveStartKey: lastKey })
    );
    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export async function cacheScore(score: RepoComplianceScore): Promise<void> {
  if (!usesDynamo()) {
    const idx = memCache.findIndex((s) => s.repo === score.repo);
    if (idx >= 0) memCache[idx] = score;
    else memCache.push(score);
    return;
  }
  await docClient.send(new PutCommand({ TableName: TABLE(), Item: score }));
}

export async function refreshRepo(token: string, repoName: string): Promise<RepoComplianceScore> {
  const octokit = createOctokit(token);
  const score = await calculateRepoCompliance(octokit, repoName, token);
  await cacheScore(score);
  return score;
}

export async function refreshAll(token: string): Promise<RepoComplianceScore[]> {
  const octokit = createOctokit(token);
  const org = getOrg();

  const repos: any[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page });
    if (data.length === 0) break;
    repos.push(...data);
    if (data.length < 100) break;
    page++;
  }

  const CONCURRENCY = 3;
  const scores: RepoComplianceScore[] = [];
  for (let i = 0; i < repos.length; i += CONCURRENCY) {
    const batch = repos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (r: any) => {
        try {
          const score = await calculateRepoCompliance(octokit, r.name, token);
          await cacheScore(score);
          return score;
        } catch (err) {
          console.warn(`[ComplianceCache] Failed to evaluate ${r.name}:`, (err as Error).message);
          const fallback: RepoComplianceScore = {
            repo: r.name, score: -1, protectionsActive: false, rulesetsActive: false,
            hasRequiredFiles: false, outsideCollaborators: 0,
            issues: ["Compliance check failed"],
            lastChecked: new Date().toISOString(), ruleResults: [],
          };
          await cacheScore(fallback);
          return fallback;
        }
      })
    );
    scores.push(...results);
  }
  return scores;
}
