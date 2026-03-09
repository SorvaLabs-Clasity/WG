import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchScanners,
  createScanner,
  updateScanner,
  deleteScanner,
  fetchScanResult,
  runScan,
} from "../api/scanners";
import type { Scanner } from "../types/Scanner";

export function useScanners() {
  return useQuery({
    queryKey: ["scanners"],
    queryFn: fetchScanners,
  });
}

export function useScanResult(id: string | null) {
  return useQuery({
    queryKey: ["scanners", id, "results"],
    queryFn: () => fetchScanResult(id!),
    enabled: !!id,
  });
}

export function useCreateScanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Omit<Scanner, "id" | "createdAt" | "updatedAt">) => createScanner(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scanners"] });
    },
  });
}

export function useUpdateScanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Omit<Scanner, "id" | "createdAt" | "updatedAt">> }) => 
      updateScanner(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scanners"] });
    },
  });
}

export function useDeleteScanner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteScanner(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scanners"] });
    },
  });
}

export function useRunScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => runScan(id),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["scanners"] });
      qc.invalidateQueries({ queryKey: ["scanners", id, "results"] });
    },
  });
}
