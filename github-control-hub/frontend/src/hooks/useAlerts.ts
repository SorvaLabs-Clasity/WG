import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAlerts, resolveAlert, unresolveAlert, simulateAlert, fetchInactiveUsers } from "../api/alerts";

export function useAlerts() {
  return useQuery({
    queryKey: ["alerts"],
    queryFn: fetchAlerts,
    refetchInterval: 10000, // Refresh every 10s for demo
  });
}

export function useResolveAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: resolveAlert,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useUnresolveAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: unresolveAlert,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useSimulateAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: simulateAlert,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
}

export function useInactiveUsers() {
  return useQuery({
    queryKey: ["inactive-users"],
    queryFn: fetchInactiveUsers,
  });
}
