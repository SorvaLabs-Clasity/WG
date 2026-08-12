import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchCatalog, fetchGuardrails, createGuardrail, updateGuardrail, deleteGuardrail,
  fetchFindings, runGuardrails, fetchAwsExclusions, createAwsExclusion,
  updateAwsExclusion, deleteAwsExclusion,
  fetchAwsAccounts, saveAwsAccount, removeAwsAccount, verifyAwsAccount, discoverAwsAccounts,
} from "../api/aws";
import type { Guardrail, AwsExclusionList, AwsAccount } from "../api/aws";

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

export function useAwsAccounts() {
  // Changes only when someone edits them, and every findings row is read
  // against this list, so it is worth not refetching constantly.
  return useQuery({ queryKey: ["aws", "accounts"], queryFn: fetchAwsAccounts, staleTime: 60_000 });
}

/**
 * Only fetched when the accounts screen asks for it: it calls out to AWS
 * Organizations, which is not something to do on every page load.
 */
export function useDiscoverAwsAccounts(enabled: boolean) {
  return useQuery({
    queryKey: ["aws", "accounts", "discover"],
    queryFn: discoverAwsAccounts,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSaveAwsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AwsAccount>) => saveAwsAccount(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useRemoveAwsAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => removeAwsAccount(accountId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useVerifyAwsAccount() {
  return useMutation({ mutationFn: (accountId: string) => verifyAwsAccount(accountId) });
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
    mutationFn: (body: { ruleIds?: string[]; resourceIds?: string[]; accountIds?: string[] }) => runGuardrails(body),
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
