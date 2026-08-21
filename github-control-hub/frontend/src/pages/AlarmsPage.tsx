import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Page, PageHeader, Empty, Spinner, LoadFailed, RefreshButton } from "../design";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../App";
import { useWidgets } from "../hooks/useWidgets";
import { useAlarms, useUpdateAlarm, useDeleteAlarm, useEmailGroups } from "../hooks/useAlarms";
import EmailGroupsPanel from "../components/EmailGroupsPanel";
import AlarmModal from "../components/AlarmModal";
import { describeCondition, describeInterval, type WidgetAlarm } from "../api/alarms";
import { ALL_METRIC_SPECS } from "../lib/alarmSpecs";

/**
 * Everything about alarms in one place: what is watching what, what state each
 * one is in, and the groups they email.
 *
 * The individual alarm is still created from its widget — that is where you
 * know what you want to be told about — but managing them one widget at a time
 * meant there was no way to answer "what is currently watching anything?".
 */
export default function AlarmsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;

  const { data: alarms, isLoading, isError, error, isFetching, refetch } = useAlarms(isAdmin);
  const { data: widgets } = useWidgets();
  const { data: groups } = useEmailGroups(isAdmin);
  const updateAlarm = useUpdateAlarm();
  const deleteAlarm = useDeleteAlarm();

  const [editing, setEditing] = useState<WidgetAlarm | null>(null);

  const widgetById = useMemo(
    () => new Map((widgets ?? []).map(w => [w.id, w])),
    [widgets]);
  const groupById = useMemo(
    () => new Map((groups ?? []).map(g => [g.id, g])),
    [groups]);

  if (!isAdmin) {
    return (
      <Page user={user}>
        <PageHeader title="Alarms" subtitle="Thresholds on widgets, and who hears about them." />
        <Empty
          title="Admins only"
          body={`Alarms send mail on behalf of the whole organization, so they are managed by ` +
            `members of the "${permissions?.awsAdminTeam ?? "admin"}" team and organization owners.`}
        />
      </Page>
    );
  }

  const rows = alarms ?? [];

  return (
    <Page user={user}>
      <PageHeader
        title="Alarms"
        subtitle="Thresholds on widgets, and the email groups they notify."
        actions={<RefreshButton busy={isFetching} onRefresh={() => refetch()} />}
      />

      {isLoading ? <Spinner /> : isError ? (
        <LoadFailed what="your alarms" error={error} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          title="No alarms yet"
          body="Open a widget on the Overview page and choose “Add alarm” to watch it."
          action={<button onClick={() => navigate("/analytics")}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90">
            Go to Overview
          </button>}
        />
      ) : (
        <div className="space-y-3 mb-10">
          {rows.map(a => {
            const widget = widgetById.get(a.widgetId);
            const firing = a.state === "ALARM";
            return (
              <div key={a.id}
                className="bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-4 flex flex-wrap items-start gap-4">
                <span className={`mt-1 shrink-0 w-2.5 h-2.5 rounded-full ${
                  !a.enabled ? "bg-gray-300 dark:bg-slate-600"
                    : firing ? "bg-red-500" : "bg-green-500"}`}
                  title={!a.enabled ? "Paused" : firing ? "Firing" : "Normal"} />

                <div className="min-w-[16rem] flex-1">
                  <div className="font-bold text-gh-textBase dark:text-slate-100">{a.name}</div>
                  <div className="text-sm text-gray-600 dark:text-slate-400">
                    {widget
                      ? <>on <span className="font-semibold">{widget.title}</span> — {describeCondition(a.condition, ALL_METRIC_SPECS)}</>
                      : <span className="text-amber-700 dark:text-amber-400">its widget was deleted</span>}
                  </div>
                  <div className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                    emails {groupById.get(a.groupId)?.name ?? "a group that no longer exists"}
                    {widget && <> · checked {describeInterval(
                      widget.type === "preset" && (widget.presetId === "dependabot" || widget.presetId === "vuln-repos") ? 60 : 15)}</>}
                    {a.lastCheckedAt && <> · last checked {new Date(a.lastCheckedAt).toLocaleString()}</>}
                  </div>
                  {a.lastError && (
                    <div className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                      last check could not read a value: {a.lastError}
                    </div>
                  )}
                </div>

                <div className="text-right shrink-0">
                  <div className={`text-sm font-bold ${firing ? "text-red-600 dark:text-red-400" : "text-gray-500 dark:text-slate-400"}`}>
                    {!a.enabled ? "Paused" : firing ? "FIRING" : "Normal"}
                  </div>
                  {a.lastValue !== undefined && a.lastValue !== null && (
                    <div className="text-xs text-gray-500 dark:text-slate-400">last value {a.lastValue}</div>
                  )}
                </div>

                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => updateAlarm.mutate({ id: a.id, data: { enabled: !a.enabled } })}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200">
                    {a.enabled ? "Pause" : "Resume"}
                  </button>
                  <button onClick={() => setEditing(a)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200">
                    Edit
                  </button>
                  <button onClick={() => deleteAlarm.mutate(a.id)}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <EmailGroupsPanel />

      {editing && (
        <AlarmModal isOpen widgetId={editing.widgetId} existing={editing}
          onClose={() => setEditing(null)} />
      )}
    </Page>
  );
}
