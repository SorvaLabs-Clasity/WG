import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchCatalog, fetchGuardrails, createGuardrail, updateGuardrail, deleteGuardrail,
  fetchFindings, runGuardrails, fetchAwsExclusions, createAwsExclusion,
  updateAwsExclusion, deleteAwsExclusion,
  fetchAwsAccounts,
  remediateResource,
} from "../api/aws";
import type { Guardrail, AwsExclusionList, AwsAccount } from "../api/aws";

export function useCatalog() {
  // The rule catalog is compiled in, so it only changes on deploy.
  return useQuery({ queryKey: ["aws", "catalog"], queryFn: fetchCatalog, staleTime: Infinity });
}

/**
 * Refetched when the window regains focus, unlike the rest of the app.
 *
 * `refetchOnWindowFocus` is off globally, and for most tabs that is right — the
 * pull request walk alone is twenty-odd seconds of GitHub's rate limit, and
 * firing it every time somebody alt-tabs is not a refresh, it is a leak.
 *
 * These two are the exception because of what returning to them means. Coming
 * back to this tab after a while is usually coming back to a laptop that slept,
 * and what makes that visible is a compliance screen quietly showing what it
 * last read. Both queries are one small read of DynamoDB, so the cost of asking
 * again is nothing next to the cost of being wrong.
 */
export function useGuardrails() {
  return useQuery({
    queryKey: ["aws", "guardrails"], queryFn: fetchGuardrails,
    staleTime: 15_000, refetchOnWindowFocus: true,
  });
}

export function useFindings() {
  return useQuery({
    queryKey: ["aws", "findings"], queryFn: fetchFindings,
    staleTime: 15_000, refetchOnWindowFocus: true,
  });
}

export function useAwsExclusions() {
  return useQuery({ queryKey: ["aws", "exclusions"], queryFn: fetchAwsExclusions, staleTime: 30_000 });
}

export function useAwsAccounts() {
  // Changes only when someone edits them, and every findings row is read
  // against this list, so it is worth not refetching constantly.
  return useQuery({ queryKey: ["aws", "accounts"], queryFn: fetchAwsAccounts, staleTime: 60_000 });
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

/**
 * Fix a single failing resource.
 *
 * Invalidates findings on success so the row updates in place — a button that
 * fixes something and leaves it looking broken is one people press twice.
 */
export function useRemediateResource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: remediateResource,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aws", "findings"] });
    },
  });
}

export function useSaveAwsExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<AwsExclusionList> }) =>
      id ? updateAwsExclusion(id, body) : createAwsExclusion(body),
    // Findings too, not only the lists.
    //
    // Editing a list changes what its rules skip, and the server re-checks
    // those rules before answering. Invalidating just ["aws","exclusions"]
    // left the findings table showing the verdicts from before the edit, so
    // the fix landed and the screen still disagreed with it.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws"] }),
  });
}

export function useDeleteAwsExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteAwsExclusion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aws", "exclusions"] }),
  });
}
