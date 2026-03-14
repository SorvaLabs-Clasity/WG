import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplateApi,
  applyTemplate,
} from "../api/templates";
import type { BranchRule, TagRule, PushRule } from "../types/Template";

export function useTemplates() {
  return useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
    staleTime: 30_000,
  });
}

export function useCreateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      branches: BranchRule[];
      tags?: TagRule[];
      pushRules?: PushRule[];
      autoApplyOnNewRepo: boolean;
      exclusionLists?: string[];
    }) => createTemplate(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useUpdateTemplate() {
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
        branches: BranchRule[];
        tags?: TagRule[];
        pushRules?: PushRule[];
        autoApplyOnNewRepo: boolean;
        exclusionLists?: string[];
      }>;
    }) => updateTemplate(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteTemplateApi(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ templateId, repos }: { templateId: string; repos: string[] }) =>
      applyTemplate(templateId, repos),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
      qc.invalidateQueries({ queryKey: ["branches"] });
    },
  });
}
