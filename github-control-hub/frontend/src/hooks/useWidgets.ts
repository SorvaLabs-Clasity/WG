import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchWidgets,
  createWidgetApi,
  updateWidgetApi,
  deleteWidgetApi,
} from "../api/widgets";
import type { WidgetConfig } from "../api/widgets";

export function useWidgets() {
  return useQuery({
    queryKey: ["widgets"],
    queryFn: fetchWidgets,
    staleTime: 30_000,
  });
}

export function useCreateWidget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) =>
      createWidgetApi(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widgets"] });
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
      qc.invalidateQueries({ queryKey: ["widgets"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}

export function useDeleteWidget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteWidgetApi(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["widgets"] });
      qc.invalidateQueries({ queryKey: ["activity"] });
    },
  });
}
