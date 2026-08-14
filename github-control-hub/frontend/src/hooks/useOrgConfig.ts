import { useQuery } from "@tanstack/react-query";
import { fetchOrgConfig } from "../api/org";

export function useOrgConfig() {
  return useQuery({
    queryKey: ["org-config"],
    queryFn: fetchOrgConfig,
  });
}
