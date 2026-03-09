import { useQuery } from "@tanstack/react-query";
import { fetchActivity } from "../api/activity";

export function useActivity(limit = 50, offset = 0, repo?: string) {
  return useQuery({
    queryKey: ["activity", limit, offset, repo],
    queryFn: () => fetchActivity(limit, offset, repo),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}
