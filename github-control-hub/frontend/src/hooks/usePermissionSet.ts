import { useQuery } from "@tanstack/react-query";
import { fetchMyPermissions, type MyPermissions } from "../api/me";

/**
 * What this person may do, as the server sees it.
 *
 * The client renders against this; it never decides anything. Every answer here
 * is also enforced server-side, so a stale or wrong value costs a confusing
 * screen rather than an unauthorized action.
 *
 * `enforced: false` means the flag is off and the old team gates are still
 * deciding — in that state the client must behave exactly as it did before,
 * which is why `can()` answers true for everything until it flips.
 */
export function usePermissionSet() {
  const query = useQuery({
    queryKey: ["me", "permissions"],
    queryFn: fetchMyPermissions,
    staleTime: 60_000,
  });

  const data = query.data;
  const held = new Set(data?.held ?? []);

  /** Whether a permission is held. True for everything until the flag is on. */
  const can = (key: string): boolean => {
    if (!data) return true;             // still loading: do not flash an empty app
    if (!data.enforced || data.inert) return true;
    if (data.failure) return false;     // could not ask: show nothing rather than a lie
    return held.has(key);
  };

  return { ...query, can, permissions: data };
}

export type { MyPermissions };
