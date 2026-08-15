import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchAlarms, fetchWidgetConditions, fetchTemplateVariables,
  createAlarmApi, updateAlarmApi, deleteAlarmApi,
  fetchGroups, createGroupApi, deleteGroupApi,
  addGroupMemberApi, removeGroupMemberApi, testGroupApi,
  fetchSecuritySettings, saveSecuritySettingsApi,
  fetchFeedSettings, saveFeedSettingsApi,
  type WidgetAlarm, type SecurityNotifySettings,
  type FeedNotifySettings, type NotifyFeed,
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
export const useDeleteGroup = () =>
  useAlarmMutation(({ id, force }: { id: string; force?: boolean }) => deleteGroupApi(id, force),
    ["alarms", "groups"], ["alarms"]);
export const useAddGroupMember = () =>
  useAlarmMutation(({ id, email }: { id: string; email: string }) => addGroupMemberApi(id, email),
    ["alarms", "groups"]);
export const useRemoveGroupMember = () =>
  useAlarmMutation(({ id, subscriptionArn }: { id: string; subscriptionArn: string }) =>
    removeGroupMemberApi(id, subscriptionArn), ["alarms", "groups"]);
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
