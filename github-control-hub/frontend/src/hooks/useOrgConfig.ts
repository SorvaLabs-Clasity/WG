import { useQuery } from "@tanstack/react-query";
import { fetchOrgConfig, fetchOrgMembers } from "../api/org";

export function useOrgConfig() {
  return useQuery({
    queryKey: ["org-config"],
    queryFn: fetchOrgConfig,
  });
}

/**
 * Everyone in the organization, for pickers that must not accept a stranger.
 *
 * Held for a while on purpose: membership changes on the scale of weeks, and
 * the list is read every time somebody opens a name box.
 */
export function useOrgMembers(enabled = true) {
  return useQuery({
    queryKey: ["org-members"],
    queryFn: fetchOrgMembers,
    enabled,
    staleTime: 600_000,
  });
}
