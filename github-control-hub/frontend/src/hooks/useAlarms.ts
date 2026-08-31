import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlarms, fetchWidgetConditions, fetchTemplateVariables,
  createAlarmApi, updateAlarmApi, deleteAlarmApi,
  fetchGroups, createGroupApi, deleteGroupApi,
  addGroupMemberApi, removeGroupMemberApi, testGroupApi,
  addGroupTeams, removeGroupTeams, fetchTeamsFlow, saveTeamsFlow,
  fetchSecuritySettings, saveSecuritySettingsApi,
  fetchFeedSettings, saveFeedSettingsApi,
  setRecipientTimeZone, setGroupTimeZone,
  type WidgetAlarm, type SecurityNotifySettings,
  type FeedNotifySettings, type NotifyFeed,

  fetchMyAlarms, createMyAlarm, updateMyAlarm, deleteMyAlarm, fetchMyDestination, addMyEmail, removeMyEmail, addMyTeams, removeMyTeams, setMyTimeZone,
} from "../api/alarms";

/**
 * Every one of these is admin-only on the server, so the hooks are given
 * `enabled` flags by their callers rather than firing for everyone and
 * collecting 403s in the console.
 */

export function useAlarms(enabled = true) {
  return useQuery({ queryKey: ["alarms"], queryFn: fetchAlarms, enabled });
}

export function useWidgetConditions(widgetId: string | null) {
  return useQuery({
    queryKey: ["alarms", "conditions", widgetId],
    queryFn: () => fetchWidgetConditions(widgetId!),
    enabled: !!widgetId,
  });
}

export function useTemplateVariables(enabled = true) {
  return useQuery({
    queryKey: ["alarms", "variables"],
    queryFn: fetchTemplateVariables,
    // The catalogue only changes when the app is rebuilt.
    staleTime: Infinity,
    enabled,
  });
}

/**
 * A Teams recipient's own timezone, and the group's.
 *
 * Both invalidate the groups query rather than patching the cache: the server
 * decides what was actually stored, including rejecting a zone it does not
 * know, and a local guess would show a setting that did not take.
 */
export function useSetRecipientTimeZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, address, timeZone }: { id: string; address: string; timeZone: string }) =>
      setRecipientTimeZone(id, address, timeZone),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alarms", "groups"] }),
  });
}

export function useSetGroupTimeZone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, timeZone }: { id: string; timeZone: string }) => setGroupTimeZone(id, timeZone),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alarms", "groups"] }),
  });
}

export function useEmailGroups(enabled = true) {
  return useQuery({
    queryKey: ["alarms", "groups"],
    queryFn: fetchGroups,
    // Membership changes out of band when somebody clicks a confirmation link,
    // so this is refetched rather than trusted indefinitely.
    refetchInterval: enabled ? 30_000 : false,
    enabled,
  });
}

export function useSecuritySettings(enabled = true) {
  return useQuery({
    queryKey: ["alarms", "security"],
    queryFn: fetchSecuritySettings,
    enabled,
  });
}

function useAlarmMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>, ...keys: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of keys.length ? keys : [["alarms"]]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export const useCreateAlarm = () =>
  useAlarmMutation((data: Partial<WidgetAlarm> & { widgetId: string }) => createAlarmApi(data));
export const useUpdateAlarm = () =>
  useAlarmMutation(({ id, data }: { id: string; data: Partial<WidgetAlarm> }) => updateAlarmApi(id, data));
export const useDeleteAlarm = () =>
  useAlarmMutation((id: string) => deleteAlarmApi(id));

export const useCreateGroup = () =>
  useAlarmMutation((name: string) => createGroupApi(name), ["alarms", "groups"]);
export const useAddGroupTeams = () =>
  useAlarmMutation(({ id, address }: { id: string; address: string }) =>
    addGroupTeams(id, address), ["alarms", "groups"]);
export const useRemoveGroupTeams = () =>
  useAlarmMutation(({ id, address }: { id: string; address: string }) =>
    removeGroupTeams(id, address), ["alarms", "groups"]);

export function useTeamsFlow() {
  return useQuery({ queryKey: ["alarms", "teams-flow"], queryFn: fetchTeamsFlow, staleTime: 60_000 });
}
export const useSaveTeamsFlow = () =>
  useAlarmMutation((url: string) => saveTeamsFlow(url), ["alarms", "teams-flow"]);
export const useDeleteGroup = () =>
  useAlarmMutation(({ id, force }: { id: string; force?: boolean }) => deleteGroupApi(id, force),
    ["alarms", "groups"], ["alarms"]);
export const useAddGroupMember = () =>
  useAlarmMutation(({ id, email }: { id: string; email: string }) => addGroupMemberApi(id, email),
    ["alarms", "groups"]);
export const useRemoveGroupMember = () =>
  useAlarmMutation(({ id, subscriptionArn, email }:
    { id: string; subscriptionArn: string; email?: string }) =>
    removeGroupMemberApi(id, subscriptionArn, email), ["alarms", "groups"]);
export const useTestGroup = () =>
  useAlarmMutation((id: string) => testGroupApi(id), ["alarms", "groups"]);

export const useSaveSecuritySettings = () =>
  useAlarmMutation((data: Partial<SecurityNotifySettings>) => saveSecuritySettingsApi(data),
    ["alarms", "security"]);

export function useFeedSettings(feed: NotifyFeed, enabled = true) {
  return useQuery({
    queryKey: ["alarms", "feeds", feed],
    queryFn: () => fetchFeedSettings(feed),
    enabled,
  });
}

/**
 * Keyed by feed, so saving the Renovate toggle does not refetch the Dependabot
 * one and blank a half-typed template beside it.
 */
export const useSaveFeedSettings = (feed: NotifyFeed) =>
  useAlarmMutation((data: Partial<FeedNotifySettings>) => saveFeedSettingsApi(feed, data),
    ["alarms", "feeds", feed]);

// ── one person's own alarms ──
//
// Separate query keys from the organization's, so opening My work does not
// briefly paint somebody's private alarms into the shared Alarms tab or the
// other way round — the same reason the two widget boards do not share one.

export function useMyAlarms(enabled = true) {
  return useQuery({ queryKey: ["alarms", "mine"], queryFn: fetchMyAlarms, enabled });
}

export const useCreateMyAlarm = () =>
  useAlarmMutation((data: Partial<WidgetAlarm> & { widgetId: string }) => createMyAlarm(data),
    ["alarms", "mine"]);
export const useUpdateMyAlarm = () =>
  useAlarmMutation(({ id, data }: { id: string; data: Partial<WidgetAlarm> }) =>
    updateMyAlarm(id, data), ["alarms", "mine"]);
export const useDeleteMyAlarm = () =>
  useAlarmMutation((id: string) => deleteMyAlarm(id), ["alarms", "mine"]);

export function useMyDestination(enabled = true) {
  return useQuery({
    queryKey: ["alarms", "mine", "destination"],
    queryFn: fetchMyDestination,
    // A confirmation link is clicked outside this app, so the state changes
    // without anything here knowing.
    refetchInterval: enabled ? 30_000 : false,
    enabled,
  });
}

const DEST_KEY = ["alarms", "mine", "destination"];
export const useAddMyEmail = () => useAlarmMutation((email: string) => addMyEmail(email), DEST_KEY);
export const useRemoveMyEmail = () =>
  useAlarmMutation(({ arn, email }: { arn: string; email: string }) =>
    removeMyEmail(arn, email), DEST_KEY);
export const useAddMyTeams = () => useAlarmMutation((a: string) => addMyTeams(a), DEST_KEY);
export const useRemoveMyTeams = () => useAlarmMutation((a: string) => removeMyTeams(a), DEST_KEY);
export const useSetMyTimeZone = () =>
  useAlarmMutation((tz: string | null) => setMyTimeZone(tz), DEST_KEY);
