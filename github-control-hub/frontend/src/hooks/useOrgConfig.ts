import { useQuery } from "@tanstack/react-query";
import { fetchOrgConfig, fetchOrgActors } from "../api/org";

export function useOrgConfig() {
  return useQuery({
    queryKey: ["org-config"],
    queryFn: fetchOrgConfig,
  });
}

export function useOrgActors(enabled = true) {
  return useQuery({
    queryKey: ["org-actors"],
    queryFn: fetchOrgActors,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}
