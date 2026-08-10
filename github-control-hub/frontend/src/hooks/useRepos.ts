import { useQuery } from "@tanstack/react-query";
import { fetchRepos, fetchRepoDetails } from "../api/repos";

export function useRepos() {
  return useQuery({
    queryKey: ["repos"],
    queryFn: fetchRepos,
    staleTime: 30_000,
  });
}

/** Detail for a single repo. Only fires once a repo is selected. */
export function useRepoDetails(repo: string | null) {
  return useQuery({
    queryKey: ["repo-details", repo],
    queryFn: () => fetchRepoDetails(repo!),
    enabled: !!repo,
    staleTime: 60_000,
  });
}
