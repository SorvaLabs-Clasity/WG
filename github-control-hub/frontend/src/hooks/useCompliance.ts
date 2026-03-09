import { useQuery } from "@tanstack/react-query";
import { fetchComplianceDashboard } from "../api/compliance";

export function useComplianceDashboard() {
  return useQuery({
    queryKey: ["compliance-dashboard"],
    queryFn: fetchComplianceDashboard,
    refetchInterval: 30000,
  });
}
