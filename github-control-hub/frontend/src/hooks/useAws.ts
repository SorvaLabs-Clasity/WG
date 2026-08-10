import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchCatalog, fetchGuardrails, createGuardrail, updateGuardrail, deleteGuardrail,
  fetchFindings, runGuardrails, fetchAwsExclusions, createAwsExclusion,
  updateAwsExclusion, deleteAwsExclusion,
} from "../api/aws";
import type { Guardrail, AwsExclusionList } from "../api/aws";

export function useCatalog() {
  // The rule catalog is compiled in, so it only changes on deploy.
  return useQuery({ queryKey: ["aws", "catalog"], queryFn: fetchCatalog, staleTime: Infinity });
}

export function useGuardrails() {
  return useQuery({ queryKey: ["aws", "guardrails"], queryFn: fetchGuardrails, staleTime: 15_000 });
}

export function useFindings() {
  return useQuery({ queryKey: ["aws", "findings"], queryFn: fetchFindings, staleTime: 15_000 });
}

export function useAwsExclusions() {
  return useQuery({ queryKey: ["aws", "exclusions"], queryFn: fetchAwsExclusions, staleTime: 30_000 });
}

export function useCreateGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Guardrail>) => createGuardrail(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useUpdateGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Guardrail> }) => updateGuardrail(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useDeleteGuardrail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteGuardrail(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useRunGuardrails() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ruleIds?: string[]; resourceIds?: string[] }) => runGuardrails(body),
    // A run rewrites findings and may have changed AWS, so refresh everything.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useSaveAwsExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<AwsExclusionList> }) =>
      id ? updateAwsExclusion(id, body) : createAwsExclusion(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws", "exclusions"] }),
  });
}

export function useDeleteAwsExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAwsExclusion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws", "exclusions"] }),
  });
}
