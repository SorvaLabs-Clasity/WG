import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchExclusions,
  fetchResolvedRepos,
  createExclusion,
  updateExclusion,
  deleteExclusionApi,
} from "../api/exclusions";
import type { ExclusionPattern } from "../types/Template";

export function useExclusions() {
  return useQuery({
    queryKey: ["exclusions"],
    queryFn: fetchExclusions,
    staleTime: 30_000,
  });
}

export function useResolvedRepos(exclusionId: string | null) {
  return useQuery({
    queryKey: ["exclusion-resolved", exclusionId],
    queryFn: () => fetchResolvedRepos(exclusionId!),
    enabled: !!exclusionId,
    staleTime: 60_000,
  });
}

export function useCreateExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      repos: string[];
      patterns: ExclusionPattern[];
      patternWhitelist: string[];
      forceTemplateIds: string[];
      forceOnNewTemplates: boolean;
    }) => createExclusion(data),
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
      data: Partial<{
        name: string;
        description: string;
        repos: string[];
        patterns: ExclusionPattern[];
        patternWhitelist: string[];
        forceTemplateIds: string[];
        forceOnNewTemplates: boolean;
      }>;
    }) => updateExclusion(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["exclusions"] });
      qc.invalidateQueries({ queryKey: ["exclusion-resolved"] });
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
