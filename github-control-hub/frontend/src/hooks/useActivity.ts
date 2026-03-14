import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchActivity, undoActivity, redoActivity, retryActivity, resolveConflict, undoResolution } from "../api/activity";

export function useActivity(limit = 50, offset = 0, repo?: string) {
  return useQuery({
    queryKey: ["activity", limit, offset, repo],
    queryFn: () => fetchActivity(limit, offset, repo),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

export function useUndoActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => undoActivity(activityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useRedoActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => redoActivity(activityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useRetryActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => retryActivity(activityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useUndoResolution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (activityId: string) => undoResolution(activityId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useResolveConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ activityId, resolution }: { activityId: string; resolution: "override" | "skip" }) =>
      resolveConflict(activityId, resolution),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
