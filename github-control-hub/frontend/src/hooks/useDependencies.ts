import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDependencies, fetchDependencySummary, enableDependabot } from "../api/dependencies";

export function useDependencies() {
  return useQuery({
    queryKey: ["dependencies"],
    queryFn: fetchDependencies,
  });
}

export function useDependencySummary() {
  return useQuery({
    queryKey: ["dependency-summary"],
    queryFn: fetchDependencySummary,
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
