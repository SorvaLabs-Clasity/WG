/**
 * Tests for getRepoDetails.
 *
 * Two things matter here:
 *  1. A repo with Actions disabled, no environments, or no releases is normal.
 *     Those sections must degrade to null instead of failing the whole panel.
 *  2. Commit counts are read off the Link header, because GitHub's /stats/*
 *     endpoints answer 202 and compute asynchronously.
 */
process.env.GITHUB_ORG = "test-org";

import { getRepoDetails } from "./src/services/repoDetailsService";

function httpError(status: number, message: string) {
  const e: any = new Error(message);
  e.status = status;
  return e;
}

const REPO = {
  name: "api-gateway", full_name: "test-org/api-gateway", description: "Edge routing",
  html_url: "https://github.com/test-org/api-gateway", homepage: "", visibility: "private",
  default_branch: "main", archived: false, fork: false, is_template: false,
  license: { spdx_id: "MIT", name: "MIT License" }, topics: ["api", "infra"], size: 4321,
  created_at: "2024-01-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", pushed_at: "2026-08-09T00:00:00Z",
  stargazers_count: 4, watchers_count: 9, subscribers_count: 9, forks_count: 1, open_issues_count: 27,
  has_issues: true, has_projects: false, has_wiki: false, has_pages: false, has_discussions: false,
  allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: true,
  allow_auto_merge: true, delete_branch_on_merge: true, private: true,
};

function makeOctokit(opts: { commitLink?: string | null; breakEverythingOptional?: boolean }) {
  const boom = async () => { throw httpError(404, "Not Found"); };
  return {
    request: async () => ({
      headers: { link: opts.commitLink ?? undefined },
      data: opts.commitLink === null ? [] : [{ sha: "abc" }],
    }),
    rest: {
      repos: {
        get: async () => ({ data: REPO }),
        listLanguages: opts.breakEverythingOptional ? boom
          : async () => ({ data: { TypeScript: 8000, CSS: 2000 } }),
        listBranches: opts.breakEverythingOptional ? boom
          : async () => ({ data: [{ name: "main", protected: true }, { name: "dev", protected: false }] }),
        listContributors: opts.breakEverythingOptional ? boom
          : async () => ({ data: [{ login: "alice", contributions: 90, avatar_url: null }] }),
        listReleases: opts.breakEverythingOptional ? boom
          : async () => ({ data: [{ tag_name: "v1.2.0", name: "Rel", published_at: "2026-07-01T00:00:00Z" }] }),
        getAllEnvironments: opts.breakEverythingOptional ? boom
          : async () => ({ data: { environments: [{ name: "production" }] } }),
        getContent: boom, // no README/LICENSE/CODEOWNERS in either scenario
      },
      pulls: {
        list: opts.breakEverythingOptional ? boom
          : async () => ({ data: [{ number: 7, title: "Old PR", created_at: "2026-05-01T00:00:00Z", user: { login: "bob" } }] }),
      },
      actions: {
        listRepoWorkflows: opts.breakEverythingOptional ? boom
          : async () => ({ data: { workflows: [{ name: "CI", state: "active", path: ".github/workflows/ci.yml" }] } }),
      },
    },
  } as any;
}

(async () => {
  let failures = 0;
  const check = (name: string, ok: boolean, got?: unknown) => {
    console.log((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : ` -> got: ${JSON.stringify(got)}`));
    if (!ok) failures++;
  };

  // 1. Healthy repo
  const link = '<https://api.github.com/repositories/1/commits?page=2>; rel="next", ' +
               '<https://api.github.com/repositories/1/commits?page=47>; rel="last"';
  const ok = await getRepoDetails(makeOctokit({ commitLink: link }), "api-gateway");
  check("language percentages sum to 100", ok.languages!.reduce((a, l) => a + l.percent, 0) === 100, ok.languages);
  check("languages sorted by size", ok.languages![0].name === "TypeScript", ok.languages);
  check("commit count parsed from Link rel=last", ok.commitsLast30Days === 47, ok.commitsLast30Days);
  check("default branch flagged", ok.branches!.find(b => b.name === "main")!.isDefault === true, ok.branches);
  check("oldest open PR surfaced", ok.openPullRequests!.oldest!.number === 7, ok.openPullRequests);
  check("latest release surfaced", ok.latestRelease!.tag === "v1.2.0", ok.latestRelease);
  check("license falls back through spdx", ok.license === "MIT", ok.license);
  check("hasLicense true via license field even with no LICENSE file", ok.hygiene.hasLicense === true, ok.hygiene);
  check("hasReadme false when file missing", ok.hygiene.hasReadme === false, ok.hygiene);

  // 2. Single page of commits — no Link header at all
  const onePage = await getRepoDetails(makeOctokit({ commitLink: undefined }), "api-gateway");
  check("no Link header -> counts the returned page", onePage.commitsLast30Days === 1, onePage.commitsLast30Days);

  // 3. No commits in window
  const noCommits = await getRepoDetails(makeOctokit({ commitLink: null }), "api-gateway");
  check("empty commit list -> 0", noCommits.commitsLast30Days === 0, noCommits.commitsLast30Days);

  // 4. Everything optional fails — panel must still render
  const degraded = await getRepoDetails(makeOctokit({ breakEverythingOptional: true, commitLink: null }), "api-gateway");
  check("core fields survive total optional failure", degraded.name === "api-gateway", degraded.name);
  check("languages degrade to null", degraded.languages === null, degraded.languages);
  check("workflows degrade to null", degraded.workflows === null, degraded.workflows);
  check("environments degrade to null", degraded.environments === null, degraded.environments);
  check("contributors degrade to null", degraded.contributors === null, degraded.contributors);
  check("releases degrade to null", degraded.latestRelease === null, degraded.latestRelease);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
