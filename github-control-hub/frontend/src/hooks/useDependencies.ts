import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
 * The list is expensive: one request per repository, because GitHub has no
 * org-wide endpoint for whether alerts are switched on. Refetching after every
 * toggle would make enabling a few hundred repositories cost a few hundred full
 * sweeps — tens of thousands of requests, and a rate limit long before the end.
 *
 * So the refetch is debounced. Toggling twenty repositories in a row settles
 * into one sweep once the clicking stops. The cache is corrected immediately
 * from what we just did, so the screen is right the whole time regardless.
 *
 * Module-level, not per-hook: enable and disable are separate hooks and both
 * must share the same timer or a mixed run schedules two sweeps.
 */
const SETTLE_MS = 8000;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSweep(queryClient: QueryClient) {
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    queryClient.invalidateQueries({ queryKey: ["dependencies"] });
    queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });
  }, SETTLE_MS);
}

/**
 * Correct the cache from what we just did, then let one later sweep confirm.
 *
 * Invalidating alone was not enough: the refetch goes out milliseconds after
 * the write and GitHub still reports the previous state, so the query settled
 * on stale data and sat there until the app restarted.
 */
function useDependabotToggle(
  mutationFn: (repo: string) => Promise<{ success: boolean }>,
  enabling: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, repo) => {
      queryClient.setQueryData(["dependencies"], (old: DependencyAlert[] | undefined) =>
        old?.map(a => {
          if (a.repo !== repo) return a;
          if (!enabling) {
            return { ...a, disabled: true, scanning: false, clean: false };
          }
          // The row being flipped is the "alerts disabled" placeholder, which
          // carries a dependency name and a severity. Clearing `disabled`
          // without clearing those left it rendering as a real vulnerability
          // called "Dependabot alerts disabled" until the sweep landed.
          return { ...a, disabled: false, scanning: true, clean: false };
        }));

      scheduleSweep(queryClient);
    },
  });
}

export function useEnableDependabot() {
  return useDependabotToggle(enableDependabot, true);
}

export function useDisableDependabot() {
  return useDependabotToggle(disableDependabot, false);
}
