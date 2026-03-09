import { useQuery } from "@tanstack/react-query";
import { fetchDependencies, fetchDependencySummary } from "../api/dependencies";

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
