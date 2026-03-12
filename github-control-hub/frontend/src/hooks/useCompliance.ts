import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchComplianceDashboard, fetchComplianceConfig, saveComplianceConfig, refreshComplianceDashboard } from "../api/compliance";
import type { ComplianceConfig } from "../types/Compliance";

export function useComplianceDashboard() {
  return useQuery({
    queryKey: ["compliance-dashboard"],
    queryFn: fetchComplianceDashboard,
    staleTime: 120_000,
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
    mutationFn: (config: ComplianceConfig) => saveComplianceConfig(config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["compliance-config"] });
      qc.invalidateQueries({ queryKey: ["compliance-dashboard"] });
    },
  });
}
