import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlerts, simulateAlert } from "../api/alerts";

export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: fetchAlerts,
    refetchInterval: 10000, // Refresh every 10s for demo
  });
}

/*
 * `useResolveAlert` and `useUnresolveAlert` were removed with the button.
 *
 * An alert is a record, not a task: it ages out on its own, and the only thing
 * that still marks one is the webhook worker noticing the change was undone.
 * The server no longer exposes a route for either.
 */

export function useSimulateAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: simulateAlert,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

