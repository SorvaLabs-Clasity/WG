import { useQuery } from "@tanstack/react-query";
import { fetchInventory, fetchBlastRadius } from "../api/resources";

/**
 * The account's resources, filtered.
 *
 * The filter is applied server-side against a listing held for a minute, so
 * typing costs one HTTP round trip per keystroke and zero AWS calls after the
 * first — the listing itself is what is expensive, not the matching.
 */
export function useInventory(q: string) {
  return useQuery({
    queryKey: ["aws-inventory", q],
    queryFn: () => fetchInventory(q),
    staleTime: 60_000,
  });
}

/**
 * What breaks if a resource goes.
 *
 * Only once a resource is actually chosen. Each one costs GitHub code searches
 * against an allowance of ten a minute, so this must never fire on hover or on
 * a list render.
 */
export function useBlastRadius(service: string | null, name: string | null) {
  return useQuery({
    queryKey: ["aws-blast", service, name],
    queryFn: () => fetchBlastRadius(service!, name!),
    enabled: !!service && !!name,
    staleTime: 5 * 60_000,
    retry: false,
  });
}
