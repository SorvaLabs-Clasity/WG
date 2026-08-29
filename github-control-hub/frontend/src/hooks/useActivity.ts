import { useQuery, useMutation, useQueryClient, QueryClient } from "@tanstack/react-query";
import { fetchActivityPulse, fetchActivity, type ActivityQuery, undoActivity, redoActivity, retryActivity, undoResolution } from "../api/activity";

/**
 * One page of the feed, with filters applied on the server.
 *
 * `cursor` is whatever the previous page returned. Every filter is part of the
 * query key, so changing one fetches rather than re-slicing what is already
 * loaded, which is what made search blind to anything older than the first
 * hundred rows.
 */
export function useActivity(
  limit = 50,
  cursor?: string,
  repo?: string,
  query: ActivityQuery = {},
) {
  return useQuery({
    queryKey: ["activity", limit, cursor, repo, query],
    queryFn: () => fetchActivity(limit, cursor, repo, query),
    staleTime: 10_000,
    // Only the first page auto-refreshes. Re-fetching a deep page every fifteen
    // seconds would fight whoever is reading it.
    refetchInterval: cursor ? false : 15_000,
    placeholderData: (prev: any) => prev,
  });
}

/** Undo/redo/retry can affect many domain entities, invalidate all relevant caches */
function invalidateAll(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["activity"] });
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

/**
 * The feed's shape, polled slowly.
 *
 * Far cheaper to read than it looks: the server caches it for a minute, so a
 * room full of open apps costs one walk a minute between them rather than one
 * each. Slower than the table's own poll because it is a backdrop, not a
 * ticker.
 */
export function useActivityPulse(hours = 168) {
  return useQuery({
    queryKey: ["activity", "pulse", hours],
    queryFn: () => fetchActivityPulse(hours),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
