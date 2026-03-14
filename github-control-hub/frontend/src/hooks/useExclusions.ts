import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchExclusions,
  createExclusion,
  updateExclusion,
  deleteExclusionApi,
} from "../api/exclusions";

export function useExclusions() {
  return useQuery({
    queryKey: ["exclusions"],
    queryFn: fetchExclusions,
    staleTime: 30_000,
  });
}

export function useCreateExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; description: string; repos: string[]; forceTemplateIds: string[]; forceOnNewTemplates: boolean }) =>
      createExclusion(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exclusions"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useUpdateExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Partial<{ name: string; description: string; repos: string[]; forceTemplateIds: string[]; forceOnNewTemplates: boolean }>;
    }) => updateExclusion(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exclusions"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDeleteExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteExclusionApi(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exclusions"] });
      qc.invalidateQueries({ queryKey: ["templates"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
