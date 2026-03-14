import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchRuleTemplates,
  createRuleTemplate,
  updateRuleTemplate,
  deleteRuleTemplateApi,
} from "../api/ruleTemplates";
import type { RuleTemplateType } from "../types/RuleTemplate";

export function useRuleTemplates() {
  return useQuery({
    queryKey: ["ruleTemplates"],
    queryFn: fetchRuleTemplates,
    staleTime: 30_000,
  });
}

export function useCreateRuleTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      ruleType: RuleTemplateType;
      branchProtection?: any;
      tagProtection?: any;
      pushProtection?: any;
    }) => createRuleTemplate(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ruleTemplates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useUpdateRuleTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<{
        name: string;
        description: string;
        ruleType: RuleTemplateType;
        branchProtection?: any;
        tagProtection?: any;
        pushProtection?: any;
      }>;
    }) => updateRuleTemplate(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ruleTemplates"] }),
  });
}

export function useDeleteRuleTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteRuleTemplateApi(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ruleTemplates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
