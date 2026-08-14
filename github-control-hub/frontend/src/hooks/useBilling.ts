import { useQuery } from "@tanstack/react-query";
import { fetchUsage } from "../api/billing";

/**
 * Billing figures change once a day at most, so this is cached hard. It is also
 * admin-only on the server, so a non-admin gets a 403 — the page reads that
 * rather than retrying it.
 */
export function useUsage(months = 6) {
  return useQuery({
    queryKey: ["billing-usage", months],
    queryFn: () => fetchUsage(months),
    staleTime: 10 * 60_000,
    retry: false,
  });
}
