import { apiGet, DEMO_MODE } from "./client";
import { mockFetchRepos } from "./mock";
import type { Repo } from "../types/Repo";

export function fetchRepos(): Promise<Repo[]> {
  if (DEMO_MODE) return mockFetchRepos();
  return apiGet<Repo[]>("/repos");
}
