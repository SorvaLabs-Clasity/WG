import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fetchDependencies, fetchDependencySummary, fetchDependenciesForRepo, enableDependabot, disableDependabot } from "../api/dependencies";
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
 * After a toggle, re-read only the repository that changed.
 *
 * The full list costs one request per repository, because GitHub has no
 * org-wide endpoint for whether alerts are switched on. Refetching it after
 * every toggle made enabling a few hundred repositories cost a few hundred
 * full sweeps. Debouncing bounded a burst of clicks but not the total — anyone
 * pausing to read each result before the next click paid full price every
 * time.
 *
 * A single repository costs one or two requests, so the cost is now
 * proportional to what changed rather than to the size of the organization.
 * The org-wide totals still need one call, and that one is debounced, since
 * being a few seconds out of date on a summary matters to nobody.
 */
const SUMMARY_SETTLE_MS = 8000;

/** GitHub needs a moment to scan a repository it has only just started watching. */
const SCAN_GRACE_MS = 6000;

let summaryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSummary(queryClient: QueryClient) {
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    queryClient.invalidateQueries({ queryKey: ["dependency-summary"] });
  }, SUMMARY_SETTLE_MS);
}

/** Replace every row for `repo` with a freshly read set. */
function mergeRepo(queryClient: QueryClient, repo: string, rows: DependencyAlert[]) {
  queryClient.setQueryData(["dependencies"], (old: DependencyAlert[] | undefined) => {
    if (!old) return old;
    const others = old.filter(a => a.repo !== repo);
    return [...others, ...rows];
  });
}

function useDependabotToggle(
  mutationFn: (repo: string) => Promise<{ success: boolean }>,
  enabling: boolean,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, repo) => {
      // Correct the screen from what we just did. GitHub reports the previous
      // state for a moment after a write, so reading it back immediately would
      // put the old answer on screen and leave it there.
      queryClient.setQueryData(["dependencies"], (old: DependencyAlert[] | undefined) =>
        old?.map(a => {
          if (a.repo !== repo) return a;
          if (!enabling) return { ...a, disabled: true, scanning: false, clean: false };
          // This row is the "alerts disabled" placeholder, which carries a
          // dependency name and a severity. Clearing `disabled` alone left it
          // rendering as a finding called "Dependabot alerts disabled".
          return { ...a, disabled: false, scanning: true, clean: false };
        }));

      scheduleSummary(queryClient);

      if (!enabling) return;
      // Give GitHub time to scan, then read back just this repository.
      setTimeout(async () => {
        try {
          const rows = await fetchDependenciesForRepo(repo);
          if (rows.length > 0) mergeRepo(queryClient, repo, rows);
        } catch {
          // Leave the optimistic state. The refresh button and the next full
          // load will settle it, and a failed read should not undo a write
          // that succeeded.
        }
      }, SCAN_GRACE_MS);
    },
  });
}

export function useEnableDependabot() {
  return useDependabotToggle(enableDependabot, true);
}

export function useDisableDependabot() {
  return useDependabotToggle(disableDependabot, false);
}
