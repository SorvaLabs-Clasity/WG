import { useQuery } from "@tanstack/react-query";
import {
  fetchAccessSummary, fetchUserAccess, fetchRepoAccess, fetchAccessRepos,
  fetchAccessTeams, fetchTeamAccess,
} from "../api/access";

/**
 * The map is derived from the graph, which is rebuilt on a schedule. Refetching
 * it on window focus would re-walk every person for an answer that cannot have
 * changed.
 */
const SETTLED = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

export function useAccessSummary() {
  return useQuery({ queryKey: ["access", "summary"], queryFn: fetchAccessSummary, ...SETTLED });
}

export function useUserAccess(login: string | null) {
  return useQuery({
    queryKey: ["access", "user", login],
    queryFn: () => fetchUserAccess(login!),
    enabled: !!login,
    ...SETTLED,
  });
}

export function useRepoAccess(repo: string | null) {
  return useQuery({
    queryKey: ["access", "repo", repo],
    queryFn: () => fetchRepoAccess(repo!),
    enabled: !!repo,
    ...SETTLED,
  });
}

export function useAccessTeams(enabled: boolean) {
  return useQuery({
    queryKey: ["access", "teams"],
    queryFn: fetchAccessTeams,
    enabled,
  });
}

export function useTeamAccess(slug: string | null) {
  return useQuery({
    queryKey: ["access", "team", slug],
    queryFn: () => fetchTeamAccess(slug!),
    enabled: !!slug,
  });
}

export function useAccessRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["access", "repos"],
    queryFn: fetchAccessRepos,
    enabled,
    ...SETTLED,
  });
}
