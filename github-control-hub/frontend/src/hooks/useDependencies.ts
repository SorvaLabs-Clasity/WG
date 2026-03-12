import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDependencies, fetchDependencySummary, enableDependabot, disableDependabot } from "../api/dependencies";

export function useDependencies() {
  return useQuery({
    queryKey: ["dependencies"],
    queryFn: fetchDependencies,
    staleTime: 120_000,
  });
}

export function useDependencySummary() {
  return useQuery({
    queryKey: ["dependency-summary"],
    queryFn: fetchDependencySummary,
    staleTime: 120_000,
  });
}

export function useEnableDependabot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: enableDependabot,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dependencies"] });
      queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });
    },
  });
}

export function useDisableDependabot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: disableDependabot,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dependencies"] });
      queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });
    },
  });
}
