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

  /**
   * "We could not ask", which is not "you may not".
   *
   * The server is careful about this distinction — a gate that cannot read the
   * file answers 503 `PERMISSIONS_UNAVAILABLE` rather than 403 — and the client
   * used to throw it away, turning every `can()` into false and silently
   * emptying the section line. During a GitHub outage that reads as a mass
   * revocation: somebody watches their whole app disappear and goes to ask for
   * access they still have.
   *
   * So it is surfaced separately. `can()` stays conservative, because an action
   * offered and then refused is worse than one not offered, but anything that
   * *hides* rather than refuses has to say this instead of quietly vanishing.
   */
  const unavailable = !!data && data.enforced && !data.inert && !!data.failure;

  /**
   * Nothing granted, and that is a real answer rather than a failure to get one.
   *
   * Deny-by-default's first day for a new arrival: the file was read, it names
   * them nowhere, and every section filters to nothing at once. `NoAccess` is
   * the screen for it — an empty section line over a wall of 403s is not.
   */
  const noAccess = !!data && data.enforced && !data.inert && !data.failure
    && data.held.length === 0;

  /** Whether a permission is held. True for everything until the flag is on. */
  const can = (key: string): boolean => {
    if (!data) return true;             // still loading: do not flash an empty app
    if (!data.enforced || data.inert) return true;
    if (data.failure) return false;     // could not ask: refuse the action, and say so elsewhere
    return held.has(key);
  };

  /** Whether any one of these is held. A tab reached two ways needs both named. */
  const canAny = (...keys: string[]): boolean => keys.some(can);

  return { ...query, can, canAny, unavailable, noAccess, permissions: data };
}

export type { MyPermissions };
