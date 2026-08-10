export interface Repo {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  updated_at: string | null;
  pushed_at?: string | null;
  created_at?: string | null;
  archived?: boolean;
  fork?: boolean;
  visibility?: string | null;
  size?: number;
  open_issues_count?: number;
  stargazers_count?: number;
  forks_count?: number;
  topics?: string[];
  html_url?: string | null;
}

/** Full detail for one repo, from GET /api/repos/:repo/details. */
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
  features: { issues: boolean; projects: boolean; wiki: boolean; pages: boolean; discussions: boolean };
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
