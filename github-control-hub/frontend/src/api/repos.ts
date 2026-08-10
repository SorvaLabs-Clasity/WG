import { apiGet, DEMO_MODE } from "./client";
import { mockFetchRepos, mockFetchRepoDetails } from "./mock";
import type { Repo, RepoDetails } from "../types/Repo";

export function fetchRepos(): Promise<Repo[]> {
  if (DEMO_MODE) return mockFetchRepos();
  return apiGet<Repo[]>("/repos");
}

export function fetchRepoDetails(repo: string): Promise<RepoDetails> {
  if (DEMO_MODE) return mockFetchRepoDetails(repo);
  return apiGet<RepoDetails>(`/repos/${encodeURIComponent(repo)}/details`);
}
