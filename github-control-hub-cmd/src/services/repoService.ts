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
      });
    }

    if (data.length < 100) break;
    page++;
  }

  return repos;
}
