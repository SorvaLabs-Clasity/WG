import crypto from "crypto";
import { Octokit } from "octokit";
import { docClient, usesDynamo, tableName, PutCommand, GetCommand, DeleteCommand, ScanCommand } from "../utils/dynamo";
import { logActivity } from "./activityService";
import { listTemplates, putTemplateRaw } from "./templateService";
import { getOrg } from "../github/client";

export type ExclusionPatternType = "starts_with" | "contains" | "created_by" | "has_codeowners_entry";

export interface ExclusionPattern {
  id: string;
  type: ExclusionPatternType;
  value: string;
}

export interface ExclusionList {
  id: string;
  name: string;
  description: string;
  repos: string[];
  patterns: ExclusionPattern[];
  patternWhitelist: string[];
  forceTemplateIds: string[];
  forceOnNewTemplates: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const TABLE = () => tableName("EXCLUSIONS_TABLE");

// In-memory fallback
const memExclusions: Map<string, ExclusionList> = new Map();

export async function listExclusions(): Promise<ExclusionList[]> {
  if (usesDynamo()) {
    const result = await docClient.send(new ScanCommand({ TableName: TABLE() }));
    return ((result.Items || []) as ExclusionList[]).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }
  return Array.from(memExclusions.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

export async function getExclusion(id: string): Promise<ExclusionList | undefined> {
  if (usesDynamo()) {
    const result = await docClient.send(new GetCommand({ TableName: TABLE(), Key: { id } }));
    return result.Item as ExclusionList | undefined;
  }
  return memExclusions.get(id);
}

export async function createExclusion(
  data: Omit<ExclusionList, "id" | "createdAt" | "updatedAt">,
  actor: string
): Promise<ExclusionList> {
  const now = new Date().toISOString();
  const exclusion: ExclusionList = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: exclusion }));
  } else {
    memExclusions.set(exclusion.id, exclusion);
  }

  await logActivity("exclusion.create", actor, "*", exclusion.name, `Created exclusion list "${exclusion.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "delete_exclusion", params: { exclusionId: exclusion.id, exclusionData: exclusion } } }
  );

  if (exclusion.forceOnNewTemplates || exclusion.forceTemplateIds.length > 0) {
    await cascadeForceToTemplates(exclusion.id, exclusion.forceTemplateIds, exclusion.forceOnNewTemplates, [], false);
  }

  return exclusion;
}

export async function updateExclusion(
  id: string,
  data: Partial<Omit<ExclusionList, "id" | "createdAt" | "updatedAt">>,
  actor: string
): Promise<ExclusionList | null> {
  const existing = await getExclusion(id);
  if (!existing) return null;

  const updated: ExclusionList = {
    ...existing,
    ...data,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };

  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: updated }));
  } else {
    memExclusions.set(id, updated);
  }

  const diff: Record<string, { old: any; new: any }> = {};
  if (data.name !== undefined && data.name !== existing.name) {
    diff.name = { old: existing.name, new: data.name };
  }
  if (data.description !== undefined && data.description !== existing.description) {
    diff.description = { old: existing.description, new: data.description };
  }
  if (data.repos !== undefined && JSON.stringify(data.repos) !== JSON.stringify(existing.repos)) {
    const added = data.repos!.filter(r => !existing.repos.includes(r));
    const removed = existing.repos.filter(r => !data.repos!.includes(r));
    diff.repos = { old: existing.repos, new: data.repos };
    if (added.length > 0 || removed.length > 0) {
      (diff.repos as any).added = added;
      (diff.repos as any).removed = removed;
    }
  }
  if (data.forceTemplateIds !== undefined && JSON.stringify(data.forceTemplateIds) !== JSON.stringify(existing.forceTemplateIds)) {
    diff.forceTemplateIds = { old: existing.forceTemplateIds, new: data.forceTemplateIds };
  }
  if (data.forceOnNewTemplates !== undefined && data.forceOnNewTemplates !== existing.forceOnNewTemplates) {
    diff.forceOnNewTemplates = { old: existing.forceOnNewTemplates, new: data.forceOnNewTemplates };
  }

  await logActivity("exclusion.update", actor, "*", updated.name, `Updated exclusion list "${updated.name}"`,
    Object.keys(diff).length > 0 ? diff : undefined, "app", undefined, undefined,
    { undoPayload: { action: "revert_exclusion", params: { exclusionId: id, previousState: existing, currentState: updated } } }
  );

  await cascadeForceToTemplates(
    id,
    updated.forceTemplateIds || [],
    updated.forceOnNewTemplates || false,
    existing.forceTemplateIds || [],
    existing.forceOnNewTemplates || false
  );

  return updated;
}

async function cascadeForceToTemplates(
  exclusionId: string,
  newForceTemplateIds: string[],
  newForceOnNew: boolean,
  oldForceTemplateIds: string[],
  oldForceOnNew: boolean
): Promise<void> {
  const templates = await listTemplates();

  for (const tmpl of templates) {
    const has = (tmpl.exclusionLists || []).includes(exclusionId);
    const shouldForce =
      newForceOnNew ||
      newForceTemplateIds.includes(tmpl.id);
    const wasForced =
      oldForceOnNew ||
      oldForceTemplateIds.includes(tmpl.id);

    if (shouldForce && !has) {
      await putTemplateRaw({ ...tmpl, exclusionLists: [...(tmpl.exclusionLists || []), exclusionId] });
    }
  }
}

export async function putExclusionRaw(exclusion: ExclusionList): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new PutCommand({ TableName: TABLE(), Item: exclusion }));
  } else {
    memExclusions.set(exclusion.id, exclusion);
  }
}

export async function deleteExclusionRaw(id: string): Promise<void> {
  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memExclusions.delete(id);
  }
}

export async function deleteExclusion(id: string, actor: string): Promise<boolean> {
  const existing = await getExclusion(id);
  if (!existing) return false;

  if (usesDynamo()) {
    await docClient.send(new DeleteCommand({ TableName: TABLE(), Key: { id } }));
  } else {
    memExclusions.delete(id);
  }

  await logActivity("exclusion.delete", actor, "*", existing.name, `Deleted exclusion list "${existing.name}"`,
    undefined, "app", undefined, undefined,
    { undoPayload: { action: "restore_exclusion", params: { exclusionData: existing } } }
  );

  const templates = await listTemplates();
  for (const tmpl of templates) {
    if ((tmpl.exclusionLists || []).includes(id)) {
      await putTemplateRaw({ ...tmpl, exclusionLists: (tmpl.exclusionLists || []).filter(eid => eid !== id) });
    }
  }

  return true;
}

// ── Normalization ──

/** Ensure old records without patterns/patternWhitelist still work. */
export function normalizeExclusion(excl: ExclusionList): ExclusionList {
  return {
    ...excl,
    patterns: excl.patterns ?? [],
    patternWhitelist: excl.patternWhitelist ?? [],
  };
}

// ── Pattern Resolution Engine ──

/** Fetch all org repo names (cached for 2 min within process). */
let repoNamesCache: { names: string[]; ts: number } | null = null;
const REPO_CACHE_TTL = 120_000;

async function getAllRepoNames(octokit: Octokit): Promise<string[]> {
  if (repoNamesCache && Date.now() - repoNamesCache.ts < REPO_CACHE_TTL) {
    return repoNamesCache.names;
  }
  const org = getOrg();
  const names: string[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.repos.listForOrg({ org, per_page: 100, page });
    if (data.length === 0) break;
    names.push(...data.map(r => r.name));
    if (data.length < 100) break;
    page++;
  }
  repoNamesCache = { names, ts: Date.now() };
  return names;
}

/** CODEOWNERS content cache (per repo, 5 min TTL). */
const codeownersCache = new Map<string, { content: string | null; ts: number }>();
const CODEOWNERS_CACHE_TTL = 300_000;

async function getCodeownersContent(octokit: Octokit, repo: string): Promise<string | null> {
  const cached = codeownersCache.get(repo);
  if (cached && Date.now() - cached.ts < CODEOWNERS_CACHE_TTL) return cached.content;

  const org = getOrg();
  const paths = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
  for (const p of paths) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner: org, repo, path: p }) as any;
      if (data.content) {
        const content = Buffer.from(data.content, "base64").toString("utf-8");
        codeownersCache.set(repo, { content, ts: Date.now() });
        return content;
      }
    } catch {
      // File not found at this path, try next
    }
  }
  codeownersCache.set(repo, { content: null, ts: Date.now() });
  return null;
}

/** Resolve which repos match a single pattern. */
async function resolvePatternMatches(
  octokit: Octokit,
  pattern: ExclusionPattern,
  allRepoNames: string[],
  webhookContext?: { repoName: string; creator?: string }
): Promise<string[]> {
  const val = pattern.value.toLowerCase();

  switch (pattern.type) {
    case "starts_with":
      return allRepoNames.filter(n => n.toLowerCase().startsWith(val));

    case "contains":
      return allRepoNames.filter(n => n.toLowerCase().includes(val));

    case "created_by": {
      // Matches only repositories created while the app was watching.
      //
      // Existing repositories used to be found by searching the org audit log,
      // which needs Enterprise Cloud for API access — so on every other plan
      // that was a request guaranteed to fail, swallowed, leaving the pattern
      // silently matching nothing. Better to do what it can and say so than to
      // make a call that never works.
      if (webhookContext?.creator && webhookContext.creator.toLowerCase() === val) {
        return [webhookContext.repoName];
      }
      return [];
    }

    case "has_codeowners_entry": {
      const matched: string[] = [];
      // Process in batches of 10 to avoid rate limits
      for (let i = 0; i < allRepoNames.length; i += 10) {
        const batch = allRepoNames.slice(i, i + 10);
        const results = await Promise.allSettled(
          batch.map(async (repo) => {
            const content = await getCodeownersContent(octokit, repo);
            if (content && content.toLowerCase().includes(val)) return repo;
            return null;
          })
        );
        for (const r of results) {
          if (r.status === "fulfilled" && r.value) matched.push(r.value);
        }
      }
      return matched;
    }

    default:
      return [];
  }
}

/** Resolve all excluded repos for a single exclusion list. */
export async function resolveExcludedRepos(
  excl: ExclusionList,
  octokit: Octokit,
  webhookContext?: { repoName: string; creator?: string }
): Promise<{
  explicitRepos: string[];
  patternMatches: Record<string, string[]>;
  whitelistedRepos: string[];
  effectiveRepos: Set<string>;
}> {
  const normalized = normalizeExclusion(excl);
  const explicitRepos = normalized.repos;
  const patternMatches: Record<string, string[]> = {};
  const allPatternMatched = new Set<string>();

  if (normalized.patterns.length > 0) {
    let allRepoNames: string[];
    try {
      allRepoNames = await getAllRepoNames(octokit);
    } catch {
      allRepoNames = [];
    }
    // If webhook context provides a new repo not yet in the cached list, add it
    if (webhookContext?.repoName && !allRepoNames.includes(webhookContext.repoName)) {
      allRepoNames = [...allRepoNames, webhookContext.repoName];
    }

    for (const pattern of normalized.patterns) {
      const matches = await resolvePatternMatches(octokit, pattern, allRepoNames, webhookContext);
      patternMatches[pattern.id] = matches;
      matches.forEach(r => allPatternMatched.add(r));
    }
  }

  // Remove whitelisted repos from pattern matches
  const whitelist = new Set(normalized.patternWhitelist);
  const effectiveRepos = new Set<string>(explicitRepos);
  for (const repo of allPatternMatched) {
    if (!whitelist.has(repo)) effectiveRepos.add(repo);
  }

  return {
    explicitRepos,
    patternMatches,
    whitelistedRepos: normalized.patternWhitelist,
    effectiveRepos,
  };
}

/** Resolve excluded repos from multiple exclusion list IDs. */
export async function resolveExcludedReposFromIds(
  exclusionListIds: string[],
  octokit: Octokit,
  webhookContext?: { repoName: string; creator?: string }
): Promise<Set<string>> {
  const all = new Set<string>();
  for (const listId of exclusionListIds) {
    const excl = await getExclusion(listId);
    if (!excl) continue;
    const { effectiveRepos } = await resolveExcludedRepos(excl, octokit, webhookContext);
    effectiveRepos.forEach(r => all.add(r));
  }
  return all;
}
