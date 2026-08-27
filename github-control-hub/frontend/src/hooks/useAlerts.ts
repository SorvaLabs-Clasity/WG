import { useInfiniteQuery } from "@tanstack/react-query";
import { fetchAlerts } from "../api/alerts";

/**
 * Alerts, newest first, a window at a time.
 *
 * The server used to return the whole table and the client polled it **every
 * ten seconds** with the comment "for demo" beside it: a full scan and a full
 * transfer, 360 times an hour, per open app. Fine at seventeen rows; megabytes
 * at ten thousand.
 *
 * Now the server bounds the read to the twelve weeks the page charts and hands
 * back a cursor if that window did not fit. `complete` says which happened, so
 * the page can state what it is showing rather than drawing a truncated list as
 * though it were everything.
 *
 * A minute between polls rather than ten seconds. Nothing is lost: an alert
 * reaches whoever asked to hear about it by email within seconds of the webhook
 * arriving, so the tab does not need to be a live ticker, and React Query still
 * refetches on window focus, which is when somebody actually looks.
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
