import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchComplianceDashboard, fetchComplianceConfig, saveComplianceConfig, refreshComplianceDashboard } from "../api/compliance";
import type { ComplianceConfig } from "../types/Compliance";

export function useComplianceDashboard() {
  return useQuery({
    queryKey: ["compliance-dashboard"],
    queryFn: fetchComplianceDashboard,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useComplianceConfig() {
  return useQuery({
    queryKey: ["compliance-config"],
    queryFn: fetchComplianceConfig,
  });
}

export function useRefreshCompliance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshComplianceDashboard,
    onSuccess: (data) => {
      qc.setQueryData(["compliance-dashboard"], data);
    },
  });
}

export function useUpdateComplianceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config: ComplianceConfig) => {
      await saveComplianceConfig(config);
      const freshScores = await refreshComplianceDashboard();
      return freshScores;
    },
    onSuccess: (freshScores) => {
      qc.invalidateQueries({ queryKey: ["compliance-config"] });
      qc.setQueryData(["compliance-dashboard"], freshScores);
    },
  });
}
