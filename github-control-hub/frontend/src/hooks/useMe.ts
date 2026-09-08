import { useQuery } from "@tanstack/react-query";
import {
  fetchMyWork, fetchPushCheck, fetchShipped, fetchMyAccess,
  fetchDevAlerts, saveDevAlerts, testDevAlerts,
} from "../api/me";
import { useMutation, useQueryClient } from "@tanstack/react-query";

/**
 * The queue is meant to be left open, so it refreshes on its own.
 *
 * A minute rather than seconds: the snapshot behind it is rewritten by a
 * scheduled pass, not by this request, so polling faster only re-reads the same
 * answer. Slower and somebody would merge something and watch a stale list.
 */
export function useMyWork() {
  return useQuery({
    queryKey: ["me", "work"],
    queryFn: fetchMyWork,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

/**
 * Only asked once a repository *and* a branch are both chosen.
 *
 * `enabled` rather than a guard inside the fetcher: a half-filled form is not a
 * question, and asking it produces a 400 the user did not cause.
 */
export function usePushCheck(repo: string, branch: string) {
  return useQuery({
    queryKey: ["me", "push-check", repo, branch],
    queryFn: () => fetchPushCheck(repo, branch),
    enabled: !!repo && !!branch,
    // Protection rarely changes and this reads GitHub live, so the answer is
    // worth holding on to while somebody reads it.
    staleTime: 120_000,
    retry: false,
  });
}

export function useShipped(days: number, login?: string) {
  return useQuery({
    queryKey: ["me", "ship", days, login ?? "self"],
    queryFn: () => fetchShipped(days, login),
    staleTime: 60_000,
  });
}

/**
 * Where the signed-in person can write.
 *
 * Derived from the stored access graph, so it costs no GitHub requests and is
 * worth holding: team membership and repository grants change on the scale of
 * days, and this is read to decide whether to offer a control.
 */
export function useMyAccess() {
  return useQuery({
    queryKey: ["me", "access"],
    queryFn: fetchMyAccess,
    staleTime: 300_000,
  });
}

export function useDevAlerts() {
  return useQuery({
    queryKey: ["me", "alerts"],
    queryFn: fetchDevAlerts,
    staleTime: 60_000,
  });
}

export function useSaveDevAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: saveDevAlerts,
    // Written back rather than invalidated: the server clamps and normalises
    // what it stores, and re-reading its answer is how the form shows what was
    // actually kept instead of what was typed.
    onSuccess: data => qc.setQueryData(["me", "alerts"], data),
  });
}

export function useTestDevAlerts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: testDevAlerts,
    // A test that succeeds clears a recorded failure, and a test that fails
    // records a new one, so the panel has to re-read either way.
    onSettled: () => qc.invalidateQueries({ queryKey: ["me", "alerts"] }),
  });
}
