import { Octokit } from "octokit";
import { getOrg } from "../github/client";

/**
 * Everything the Knowledge Center panel shows for a single repo.
 *
 * Each section is optional: a repo can have Actions disabled, no environments,
 * or no releases, and none of that is an error. Sections that cannot be read
 * come back as null so the panel renders what it has instead of failing whole.
 */
export interface RepoDetails {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  homepage: string | null;
  visibility: string;
  default_branch: string;
  archived: boolean;
  fork: boolean;
  is_template: boolean;
  license: string | null;
  topics: string[];
  size_kb: number;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  stargazers_count: number;
  watchers_count: number;
  forks_count: number;
  open_issues_count: number;
  features: {
    issues: boolean;
    projects: boolean;
    wiki: boolean;
    pages: boolean;
    discussions: boolean;
  };
  mergeSettings: {
    allowSquashMerge: boolean | null;
    allowMergeCommit: boolean | null;
    allowRebaseMerge: boolean | null;
    allowAutoMerge: boolean | null;
    deleteBranchOnMerge: boolean | null;
  };
  languages: { name: string; bytes: number; percent: number }[] | null;
  branches: { name: string; protected: boolean; isDefault: boolean }[] | null;
  contributors: { login: string; contributions: number; avatarUrl: string | null }[] | null;
  contributorCount: number | null;
  openPullRequests: { count: number; oldest: { number: number; title: string; createdAt: string; author: string | null } | null } | null;
  latestRelease: { tag: string; name: string | null; publishedAt: string | null } | null;
  releaseCount: number | null;
  commitsLast30Days: number | null;
  workflows: { name: string; state: string; path: string }[] | null;
  environments: string[] | null;
  hygiene: {
    hasReadme: boolean;
    hasLicense: boolean;
    hasCodeowners: boolean;
    hasDescription: boolean;
    hasTopics: boolean;
  };
}

/** Run a section, returning null instead of throwing so one gap can't blank the panel. */
async function section<T>(label: string, repo: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err: any) {
    // 404/403 are ordinary here: Actions disabled, no environments, empty repo.
    if (err?.status !== 404 && err?.status !== 403) {
      console.warn(`[repoDetails] ${label} failed for "${repo}": ${err?.message ?? err}`);
    }
    return null;
  }
}

/**
 * Total commits since a date.
 *
 * Uses per_page=1 and reads the last page number off the Link header — that page
 * count IS the commit count. The /stats/* endpoints would be the obvious choice
 * but they return 202 and compute asynchronously on first request, which cannot
 * back a UI panel.
 */
async function countCommitsSince(octokit: Octokit, org: string, repo: string, since: string): Promise<number> {
  const res = await octokit.request("GET /repos/{owner}/{repo}/commits", {
    owner: org, repo, since, per_page: 1,
  });
  const link = res.headers.link;
  if (!link) return Array.isArray(res.data) ? res.data.length : 0; // 0 or 1 page
  const last = /<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  return last ? parseInt(last[1], 10) : (Array.isArray(res.data) ? res.data.length : 0);
}

async function fileExists(octokit: Octokit, org: string, repo: string, path: string): Promise<boolean> {
  try {
    await octokit.rest.repos.getContent({ owner: org, repo, path });
    return true;
  } catch {
    return false;
  }
}

export async function getRepoDetails(octokit: Octokit, repo: string): Promise<RepoDetails> {
  const org = getOrg();

  // The only call that must succeed — everything else decorates it.
  const { data: r } = await octokit.rest.repos.get({ owner: org, repo });

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    languages, branches, contributors, openPrs, releases, workflows, environments,
    commitsLast30Days, hasReadme, hasLicense, hasCodeownersRoot, hasCodeownersGithub, hasCodeownersDocs,
  ] = await Promise.all([
    section("languages", repo, async () => {
      const { data } = await octokit.rest.repos.listLanguages({ owner: org, repo });
      const total = Object.values(data).reduce((a, b) => a + (b as number), 0);
      if (!total) return [];
      return Object.entries(data)
        .map(([name, bytes]) => ({ name, bytes: bytes as number, percent: Math.round(((bytes as number) / total) * 1000) / 10 }))
        .sort((a, b) => b.bytes - a.bytes);
    }),
    section("branches", repo, async () => {
      const { data } = await octokit.rest.repos.listBranches({ owner: org, repo, per_page: 100 });
      return data.map(b => ({ name: b.name, protected: !!b.protected, isDefault: b.name === r.default_branch }));
    }),
    section("contributors", repo, async () => {
      const { data } = await octokit.rest.repos.listContributors({ owner: org, repo, per_page: 100 });
      return data.map(c => ({ login: c.login ?? "unknown", contributions: c.contributions ?? 0, avatarUrl: c.avatar_url ?? null }));
    }),
    section("openPullRequests", repo, async () => {
      const { data } = await octokit.rest.pulls.list({
        owner: org, repo, state: "open", sort: "created", direction: "asc", per_page: 100,
      });
      const oldest = data[0]
        ? { number: data[0].number, title: data[0].title, createdAt: data[0].created_at, author: data[0].user?.login ?? null }
        : null;
      return { count: data.length, oldest };
    }),
    section("releases", repo, async () => {
      const { data } = await octokit.rest.repos.listReleases({ owner: org, repo, per_page: 100 });
      return data;
    }),
    section("workflows", repo, async () => {
      const { data } = await octokit.rest.actions.listRepoWorkflows({ owner: org, repo, per_page: 100 });
      return data.workflows.map(w => ({ name: w.name, state: w.state, path: w.path }));
    }),
    section("environments", repo, async () => {
      const { data } = await octokit.rest.repos.getAllEnvironments({ owner: org, repo });
      return (data.environments ?? []).map(e => e.name);
    }),
    section("commits", repo, () => countCommitsSince(octokit, org, repo, since)),
    fileExists(octokit, org, repo, "README.md"),
    fileExists(octokit, org, repo, "LICENSE"),
    fileExists(octokit, org, repo, "CODEOWNERS"),
    fileExists(octokit, org, repo, ".github/CODEOWNERS"),
    fileExists(octokit, org, repo, "docs/CODEOWNERS"),
  ]);

  return {
    name: r.name,
    full_name: r.full_name,
    description: r.description ?? null,
    html_url: r.html_url,
    homepage: r.homepage || null,
    visibility: (r as any).visibility ?? (r.private ? "private" : "public"),
    default_branch: r.default_branch,
    archived: !!r.archived,
    fork: !!r.fork,
    is_template: !!(r as any).is_template,
    license: r.license?.spdx_id ?? r.license?.name ?? null,
    topics: (r as any).topics ?? [],
    size_kb: r.size ?? 0,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
    pushed_at: r.pushed_at ?? null,
    stargazers_count: r.stargazers_count ?? 0,
    watchers_count: r.subscribers_count ?? r.watchers_count ?? 0,
    forks_count: r.forks_count ?? 0,
    open_issues_count: r.open_issues_count ?? 0,
    features: {
      issues: !!r.has_issues,
      projects: !!r.has_projects,
      wiki: !!r.has_wiki,
      pages: !!r.has_pages,
      discussions: !!(r as any).has_discussions,
    },
    mergeSettings: {
      allowSquashMerge: r.allow_squash_merge ?? null,
      allowMergeCommit: r.allow_merge_commit ?? null,
      allowRebaseMerge: r.allow_rebase_merge ?? null,
      allowAutoMerge: (r as any).allow_auto_merge ?? null,
      deleteBranchOnMerge: r.delete_branch_on_merge ?? null,
    },
    languages,
    branches,
    contributors: contributors ? contributors.slice(0, 10) : null,
    contributorCount: contributors ? contributors.length : null,
    openPullRequests: openPrs,
    latestRelease: releases && releases.length
      ? { tag: releases[0].tag_name, name: releases[0].name ?? null, publishedAt: releases[0].published_at ?? null }
      : null,
    releaseCount: releases ? releases.length : null,
    commitsLast30Days,
    workflows,
    environments,
    hygiene: {
      hasReadme: hasReadme === true,
      hasLicense: hasLicense === true || !!r.license,
      hasCodeowners: hasCodeownersRoot === true || hasCodeownersGithub === true || hasCodeownersDocs === true,
      hasDescription: !!r.description,
      hasTopics: (((r as any).topics ?? []) as string[]).length > 0,
    },
  };
}
