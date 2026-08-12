import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchDependencies, fetchDependencySummary, enableDependabot, disableDependabot } from "../api/dependencies";
import type { DependencyAlert } from "../types/Dependabot";

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

/**
 * Flip the repo's state in the cache immediately, then let the refetch confirm.
 *
 * Invalidating alone was not enough. The refetch goes out milliseconds after
 * the write, and GitHub still reports the previous state — so the query
 * settled on stale data and, with a two-minute staleTime and window-focus
 * refetching off, sat there until the app was restarted.
 *
 * We know what we just did, so the cache is corrected directly. The
 * invalidation still runs, so if GitHub disagrees once it catches up, GitHub
 * wins.
 */
function useDependabotToggle(
  mutationFn: (repo: string) => Promise<{ success: boolean }>,
  disabledAfter: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, repo) => {
      queryClient.setQueryData(["dependencies"], (old: DependencyAlert[] | undefined) =>
        old?.map(a => (a.repo === repo ? { ...a, disabled: disabledAfter } : a)));

      queryClient.invalidateQueries({ queryKey: ["dependencies"] });
      queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });

      // GitHub is eventually consistent here, so the invalidation above often
      // reads the old value too. One later refetch settles it without making
      // the user wonder whether the click worked.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["dependencies"] });
        queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });
      }, 4000);
    },
  });
}

export function useEnableDependabot() {
  return useDependabotToggle(enableDependabot, false);
}

export function useDisableDependabot() {
  return useDependabotToggle(disableDependabot, true);
}
