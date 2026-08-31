import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAlerts } from "../api/alerts";

/**
 * Alerts, newest first, a window at a time.
 *
 * The server bounds the read to the twelve weeks the page charts and returns a
 * cursor if that window did not fit. `complete` says which happened, so the
 * page can state what it is showing rather than drawing a truncated list as
 * though it were everything. Returning the whole table is a full scan and a
 * full transfer per poll: fine at seventeen rows, megabytes at ten thousand.
 *
 * A minute between polls. An alert reaches whoever asked to hear about it by
 * email within seconds of the webhook, so the tab need not be a live ticker,
 * and React Query still refetches on focus, which is when somebody looks.
 */
export function useAlerts() {
  const q = useInfiniteQuery({
    queryKey: ["alerts"],
    queryFn: ({ pageParam }) => fetchAlerts(pageParam as string | undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor ?? undefined,
    refetchInterval: 60_000,
  });

  const pages = q.data?.pages ?? [];
  return {
    ...q,
    /** Every row loaded so far, newest first. */
    data: pages.flatMap(p => p.alerts),
    /** True when nothing is being withheld: what is loaded is what there is. */
    complete: pages.length > 0 && !pages[pages.length - 1].cursor,
    windowWeeks: pages[0]?.windowWeeks ?? 12,
  };
}

/*
 * `useResolveAlert` and `useUnresolveAlert` were removed with the button.
 *
 * An alert is a record, not a task: it ages out on its own, and the only thing
 * that still marks one is the webhook worker noticing the change was undone.
 * The server no longer exposes a route for either.
 */
