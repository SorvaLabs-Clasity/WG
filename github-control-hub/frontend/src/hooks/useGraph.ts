import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchGraphNode, fetchUserImpact, fetchSecurityQuery, fetchGraphMeta, triggerGraphAggregation, fetchGraphAggregation } from "../api/graph";
import { IncompleteQueryError } from "../api/client";
import { fetchQueryFreshness, refreshQueryNow } from "../api/graph";

export function useGraphMeta() {
  return useQuery({
    queryKey: ["graph", "meta"],
    queryFn: fetchGraphMeta,
    staleTime: 60_000,
  });
}

/**
 * How old the access graph is.
 *
 * Polled slowly rather than never: the scheduled rebuild lands every six hours
 * without anyone here doing anything, and a page left open would otherwise go on
 * claiming the age it had when it loaded.
 */
export function useGraphAggregation() {
  return useQuery({
    queryKey: ["graph", "aggregation"],
    queryFn: fetchGraphAggregation,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export function useTriggerAggregation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: triggerGraphAggregation,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["graph"] });
      // The access map is derived from the graph and cached separately, so
      // without this the timestamp would update while the table below it went
      // on showing what the previous walk found.
      qc.invalidateQueries({ queryKey: ["access"] });
    },
  });
}

export function useGraphNode(id: string | null) {
  return useQuery({
    queryKey: ["graph", "node", id],
    queryFn: () => fetchGraphNode(id!),
    enabled: !!id,
  });
}

export function useUserImpact(user: string | null) {
  return useQuery({
    queryKey: ["graph", "user-impact", user],
    queryFn: () => fetchUserImpact(user!),
    enabled: !!user,
  });
}

export function useSecurityQuery(q: string | null, param?: string, advanced?: any) {
  return useQuery({
    queryKey: ["graph", "security-query", q, param, advanced],
    queryFn: () => fetchSecurityQuery(q!, param, advanced),
    enabled: !!q,
    // No polling. Every one of these is a full scan of the graph table, and
    // several widgets on a page meant a scan every few seconds — visible as
    // the cards re-animating, and as a stack trace per failing widget. The
    // graph only changes when aggregation runs, which is a button.
    staleTime: 5 * 60_000,
    retry: false,
    // Polled only while a check is still building its coverage, and slowly.
    //
    // The three subject-by-subject checks answer nothing until every account or
    // repository has been read, which takes a few passes on a large
    // organization. Without this the card would sit at "checked 25 of 250"
    // until somebody reloaded — technically correct and indistinguishable from
    // stuck. Every other state keeps the old behaviour of not polling at all,
    // because each of those calls is a scan of the graph table.
    refetchInterval: (q) => (q.state.error instanceof IncompleteQueryError ? 60_000 : false),
  });
}

/**
 * How stale a batched check's stored answers are.
 *
 * Its own query rather than part of the result, because it is cheap — the cache
 * only — and the result it annotates is not. Held briefly so several cards
 * asking at once cost one call each rather than one per render.
 */
export function useQueryFreshness(q: string | null, enabled = true) {
  return useQuery({
    queryKey: ["graph", "query-freshness", q],
    queryFn: () => fetchQueryFreshness(q!),
    enabled: !!q && enabled,
    staleTime: 60_000,
  });
}

export function useRefreshQueryNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (q: string) => refreshQueryNow(q),
    onSuccess: (_r, q) => {
      // Both, and in this order: the answer may now exist, and its freshness
      // certainly changed.
      qc.invalidateQueries({ queryKey: ["graph", "security-query", q] });
      qc.invalidateQueries({ queryKey: ["graph", "query-freshness", q] });
    },
  });
}
