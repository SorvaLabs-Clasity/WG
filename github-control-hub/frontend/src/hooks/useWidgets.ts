import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchWidgets,
  fetchWidgetSnapshots,
  createWidgetApi,
  updateWidgetApi,
  deleteWidgetApi,
} from "../api/widgets";
import type { WidgetConfig } from "../api/widgets";

/**
 * The dashboard's stored answers.
 *
 * Refetched on the same rhythm the scheduled pass writes them, so a card left
 * open catches up on its own. `staleTime` is deliberately shorter than that
 * pass: it costs one small request and it is the difference between a number
 * that updates while you watch and one that needs a reload.
 */
export function useWidgetSnapshots() {
  return useQuery({
    queryKey: ["widget-snapshots"],
    queryFn: fetchWidgetSnapshots,
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useWidgets(scope?: "personal") {
  return useQuery({
    // The scope is in the key. Without it the shared board and a personal one
    // share a cache entry, so opening one shows the other's cards for a moment.
    queryKey: ["widgets", scope ?? "org"],
    queryFn: () => fetchWidgets(scope),
    staleTime: 30_000,
  });
}

export function useCreateWidget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) =>
      createWidgetApi(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widgets"] });   // both scopes: the key is a prefix
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useUpdateWidget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">> }) =>
      updateWidgetApi(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widgets"] });   // both scopes: the key is a prefix
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDeleteWidget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWidgetApi(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widgets"] });   // both scopes: the key is a prefix
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
