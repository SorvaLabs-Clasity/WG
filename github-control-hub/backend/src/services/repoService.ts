import { Octokit } from "octokit";
import { getOrg } from "../github/client";

export interface RepoSummary {
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  updated_at: string | null;
  /**
   * Everything below already arrives in the listForOrg payload and used to be
   * discarded. The repo browser filters and sorts on these, so returning them
   * costs no extra API calls.
   */
  pushed_at: string | null;
  created_at: string | null;
  archived: boolean;
  fork: boolean;
  visibility: string | null;
  size: number;
  open_issues_count: number;
  stargazers_count: number;
  forks_count: number;
  topics: string[];
  html_url: string | null;
  /**
   * Arrives on every listForOrg row and was discarded. Each field is a control
   * an auditor asks about by name, and re-reading them per repository later
   * would be one request each.
   */
  security_and_analysis?: {
    secret_scanning?: { status?: string };
    secret_scanning_push_protection?: { status?: string };
    dependabot_security_updates?: { status?: string };
    code_security?: { status?: string };
  } | null;
}

export async function listRepos(octokit: Octokit): Promise<RepoSummary[]> {
  const org = getOrg();
  const repos: RepoSummary[] = [];
  let page = 1;

  while (true) {
    const { data } = await octokit.rest.repos.listForOrg({
      org,
      per_page: 100,
      page,
      sort: "updated",
      direction: "desc",
    });

    if (data.length === 0) break;

    for (const r of data) {
      repos.push({
        name: r.name,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch ?? "main",
        description: r.description ?? null,
        language: r.language ?? null,
        updated_at: r.updated_at ?? null,
        pushed_at: r.pushed_at ?? null,
        created_at: r.created_at ?? null,
        archived: !!r.archived,
        fork: !!r.fork,
        visibility: (r as any).visibility ?? (r.private ? "private" : "public"),
        security_and_analysis: (r as any).security_and_analysis ?? null,
        size: r.size ?? 0,
        open_issues_count: r.open_issues_count ?? 0,
        stargazers_count: r.stargazers_count ?? 0,
        forks_count: r.forks_count ?? 0,
        topics: (r as any).topics ?? [],
        html_url: r.html_url ?? null,
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return repos;
}
