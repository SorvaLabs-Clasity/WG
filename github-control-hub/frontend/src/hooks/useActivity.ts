import { useQuery, useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import { fetchActivity, undoActivity, redoActivity, retryActivity, resolveConflict, undoResolution } from "../api/activity";

export function useActivity(limit = 50, offset = 0, repo?: string) {
  return useQuery({
    queryKey: ["activity", limit, offset, repo],
    queryFn: () => fetchActivity(limit, offset, repo),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/** Undo/redo/retry can affect many domain entities — invalidate all relevant caches */
function invalidateAll(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["activity"] });
  qc.invalidateQueries({ queryKey: ["templates"] });
  qc.invalidateQueries({ queryKey: ["exclusions"] });
  qc.invalidateQueries({ queryKey: ["branches"] });
  qc.invalidateQueries({ queryKey: ["rulesets"] });
  qc.invalidateQueries({ queryKey: ["protection"] });
  qc.invalidateQueries({ queryKey: ["all-protections"] });
  qc.invalidateQueries({ queryKey: ["widgets"] });
  qc.invalidateQueries({ queryKey: ["scanners"] });
  qc.invalidateQueries({ queryKey: ["compliance-dashboard"] });
}

export function useUndoActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => undoActivity(activityId),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRedoActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => redoActivity(activityId),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRetryActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => retryActivity(activityId),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useUndoResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => undoResolution(activityId),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ activityId, resolution }: { activityId: string; resolution: "override" | "skip" }) =>
      resolveConflict(activityId, resolution),
    onSuccess: () => invalidateAll(qc),
  });
}
