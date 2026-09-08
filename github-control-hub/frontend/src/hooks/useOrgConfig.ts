import { useQuery } from "@tanstack/react-query";
import { fetchOrgConfig, fetchOrgMembers } from "../api/org";

/**
 * The organization's own settings, read by almost every page.
 *
 * Held for a long time on purpose. It is the organization name, the bot's
 * login, which features are on: things somebody changes on the scale of weeks,
 * from a settings screen that invalidates this key when they do. Left at the
 * default it was re-read on every mount of every page that shows the
 * organization's name, which is most of them.
 */
export function useOrgConfig() {
  return useQuery({
    queryKey: ["org-config"],
    queryFn: fetchOrgConfig,
    staleTime: 600_000,
  });
}

/**
 * Everyone in the organization, for pickers that must not accept a stranger.
 *
 * Held for a while on purpose: membership changes on the scale of weeks, and
 * the list is read every time somebody opens a name box.
 */
export function useOrgMembers(enabled = true) {
  return useQuery({
    queryKey: ["org-members"],
    queryFn: fetchOrgMembers,
    enabled,
    staleTime: 600_000,
  });
}
