import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAuthStatus } from "../api/auth";
import { useNavigate } from "react-router-dom";
import {
  Page, PageHeader, Empty, Spinner, LoadFailed, RefreshButton, Segmented,
  SURFACE, TYPE, Button,
} from "../design";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../App";
import { useWidgets } from "../hooks/useWidgets";
import { useAlarms, useUpdateAlarm, useDeleteAlarm, useEmailGroups } from "../hooks/useAlarms";
import EmailGroupsPanel from "../components/EmailGroupsPanel";
import AlarmModal from "../components/AlarmModal";
import { describeCondition, describeInterval, type WidgetAlarm } from "../api/alarms";
import { ALL_METRIC_SPECS } from "../lib/alarmSpecs";

/**
 * Everything watching a number, and everyone it tells.
 *
 * The page it replaces was a flat list of grey rectangles: every alarm the same
 * size, in the same order, whether it was firing or paused or had not been read
 * for a week. A list where nothing stands out is a list nobody scans, and the
 * one question this page exists to answer, *is anything wrong right now*, was
 * the one thing you had to read every row to find out.
 *
 * So the count of what is firing leads, the firing ones are lifted out of the
 * list entirely, and the rest are grouped by what they watch rather than by the
 * order they happen to be stored in.
 *
 * The two halves, alarms and the groups they notify, are separate views
 * rather than one scrolling page. Managing recipients is a different task from
 * checking whether anything is on fire, and doing them on one screen meant the
 * second was always below the fold.
 */

type Lens = "alarms" | "groups";

/** Firing first, then paused, then the quiet ones, each newest first. */
function rank(a: WidgetAlarm): number {
  if (a.state === "ALARM" && a.enabled) return 0;
  if (!a.enabled) return 2;
  return 1;
}

/** What an alarm is pointed at, whichever kind it is. */
function subjectOf(a: WidgetAlarm, widgetTitle?: string): { label: string; guardrail: boolean; missing: boolean } {
  if (a.widgetId.startsWith("guardrail:")) {
    const rule = a.widgetId.slice("guardrail:".length);
    return {
      label: rule === "*" ? "All AWS guardrails" : `Guardrail rule ${rule}`,
      guardrail: true, missing: false,
    };
  }
  return { label: widgetTitle ?? "", guardrail: false, missing: !widgetTitle };
}

function StatusDot({ alarm }: { alarm: WidgetAlarm }) {
  const firing = alarm.state === "ALARM" && alarm.enabled;
  return (
    <span className="relative flex w-2.5 h-2.5 shrink-0 mt-[7px]" aria-hidden="true">
      {firing && (
        <span className="absolute inline-flex w-full h-full rounded-full bg-rose-400 opacity-70 animate-ping" />
      )}
      <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${
        !alarm.enabled ? "bg-slate-300 dark:bg-slate-600"
          : firing ? "bg-rose-500" : "bg-emerald-500"}`} />
    </span>
  );
}

function AlarmRow({ alarm, subject, groupName, interval, canEdit, onEdit, onToggle, onDelete }: {
  alarm: WidgetAlarm;
  subject: ReturnType<typeof subjectOf>;
  groupName?: string;
  /** Null when the subject is gone, so there is no interval to state. */
  interval: number | null;
  /**
   * Whether this viewer's team owns what this alarm watches.
   *
   * The server refuses either way. Hiding the controls stops somebody pressing
   * a button that was only ever going to return a permission error.
   */
  canEdit: boolean;
  onEdit: () => void; onToggle: () => void; onDelete: () => void;
}) {
  const firing = alarm.state === "ALARM" && alarm.enabled;

  return (
    <div className={`group relative flex items-start gap-3.5 pl-5 pr-4 py-4
                     hover:bg-slate-50/80 dark:hover:bg-white/[0.035] transition-colors
                     ${alarm.enabled ? "" : "opacity-60"}`}>
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${
        !alarm.enabled ? "bg-slate-200 dark:bg-slate-700"
          : firing ? "bg-rose-500" : "bg-emerald-500/70"}`} aria-hidden="true" />

      <StatusDot alarm={alarm} />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13.5px] font-semibold text-slate-900 dark:text-slate-100">{alarm.name}</span>
          {subject.guardrail && (
            <span className="text-[9.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded
                             bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-400">AWS</span>
          )}
          {!alarm.enabled && (
            <span className="text-[9.5px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded
                             bg-slate-100 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400">paused</span>
          )}
        </div>

        <div className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-1">
          {subject.missing
            // Said plainly. An alarm whose subject is gone reads zero for ever,
            // which looks exactly like nothing being wrong.
            ? <span className="text-amber-700 dark:text-amber-400">its widget was deleted</span>
            : <>on <span className="font-medium text-slate-700 dark:text-slate-300">{subject.label}</span>
                {" "}· {describeCondition(alarm.condition, ALL_METRIC_SPECS)}</>}
        </div>

        <div className="flex items-center gap-2 mt-1.5 text-[11.5px] text-slate-400 dark:text-slate-500 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <i className="ph-fill ph-users-three text-[12px]" aria-hidden="true" />
            {groupName ?? <span className="text-amber-600 dark:text-amber-500">group deleted</span>}
          </span>
          <span aria-hidden="true">·</span>
          {interval !== null && <span>checked {describeInterval(interval)}</span>}
          {alarm.lastCheckedAt ? (
            <>
              <span aria-hidden="true">·</span>
              <span>last {new Date(alarm.lastCheckedAt).toLocaleString()}</span>
            </>
          ) : (
            /* Never evaluated is not the same as recently evaluated and quiet,
               and an absent timestamp rendered as nothing made the two
               identical. An alarm that has never been read is usually an
               evaluator that is not running: a stack deployed before the alarm
               existed, or one deployed without it. That is worth saying, since
               nothing else on the page would ever mention it. */
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-600 dark:text-amber-500 font-medium">
                never checked
              </span>
            </>
          )}
        </div>

        {!alarm.lastCheckedAt && (
          <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-500/90 leading-relaxed">
            Nothing has evaluated this yet. The evaluator runs in AWS on a
            five-minute schedule, so a stack deployed before this alarm existed
            will not pick it up until it is deployed again.
          </p>
        )}

        {/* Fired, and did not arrive. Kept apart from the reading error below,
            because the two send somebody to completely different places: one is
            a broken check, the other is a healthy check nobody heard. */}
        {alarm.lastDeliveryError && (
          <p className="mt-1 text-[11.5px] text-amber-700 dark:text-amber-500/90 leading-relaxed">
            <i className="ph-bold ph-warning-circle mr-1 text-[11px]" aria-hidden="true" />
            Sent, but not delivered everywhere: {alarm.lastDeliveryError}
          </p>
        )}

        {/* A check that could not take a reading is not a passing check, and
            the difference is the whole reason this line exists. */}
        {alarm.lastError && (
          <div className="mt-2 text-[11.5px] text-amber-700 dark:text-amber-400
                          bg-amber-50 dark:bg-amber-500/10 rounded-lg px-2.5 py-1.5">
            Could not read a value: {alarm.lastError}
          </div>
        )}
      </div>

      <div className="shrink-0 text-right">
        {alarm.lastValue !== undefined && alarm.lastValue !== null && (
          <div className={`text-[20px] font-black tabular-nums leading-none
            ${firing ? "text-rose-600 dark:text-rose-400" : "text-slate-300 dark:text-slate-600"}`}>
            {alarm.lastValue}
          </div>
        )}
        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-1">
          {alarm.lastValue !== undefined && alarm.lastValue !== null ? "last read" : "no reading"}
        </div>
      </div>

      {/* Revealed on hover, so a list of twelve alarms is not also a list of
          thirty-six buttons. Kept reachable from the keyboard regardless.
          Absent entirely where this viewer's team does not own the subject:
          the server refuses, and a button that only ever produces a permission
          error is worse than no button. */}
      {canEdit && (
      <div className="shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <button onClick={onToggle} title={alarm.enabled ? "Pause" : "Resume"}
          className="w-8 h-8 grid place-items-center rounded-lg text-slate-500 dark:text-slate-400
                     hover:bg-slate-100 dark:hover:bg-white/[0.08]">
          <i className={`ph-bold ${alarm.enabled ? "ph-pause" : "ph-play"} text-[13px]`} />
        </button>
        <button onClick={onEdit} title="Edit"
          className="w-8 h-8 grid place-items-center rounded-lg text-slate-500 dark:text-slate-400
                     hover:bg-slate-100 dark:hover:bg-white/[0.08]">
          <i className="ph-bold ph-pencil-simple text-[13px]" />
        </button>
        <button onClick={onDelete} title="Delete"
          className="w-8 h-8 grid place-items-center rounded-lg text-slate-400
                     hover:bg-rose-50 dark:hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400">
          <i className="ph-bold ph-trash text-[13px]" />
        </button>
      </div>
      )}
    </div>
  );
}

export default function AlarmsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data: permissions } = usePermissions();
  /**
   * Who may see this page, and who may change what on it.
   *
   * Reading was gated on the AWS team alone, which meant somebody who
   * administers every GitHub setting in this app opened the Alarms tab and was
   * told it was for admins. Both teams keep alarms here, so both can read it.
   *
   * Changing one depends on what it watches: a guardrail alarm belongs to the
   * AWS team, a widget alarm to the Control Hub team. The server decides the
   * same way; this only keeps the controls off a row somebody cannot change.
   */
  const canSeeGithub = permissions?.isControlHubAdmin ?? false;
  const canSeeAws = permissions?.isAwsAdmin ?? false;
  const isAdmin = canSeeGithub || canSeeAws;

  const { data: alarms, isLoading, isError, error, isFetching, refetch } = useAlarms(isAdmin);
  // Only where there can be any. This page is reachable in an AWS-only
  // account, where widgets are refused and every alarm is a guardrail one.
  const { data: authStatus } = useQuery({
    queryKey: ["auth", "status"], queryFn: fetchAuthStatus, staleTime: 60_000,
  });
  const githubBlocked = authStatus?.githubAccess?.allowed === false;
  const { data: widgets } = useWidgets(undefined, !githubBlocked);
  const { data: groups } = useEmailGroups(isAdmin);
  const updateAlarm = useUpdateAlarm();
  const deleteAlarm = useDeleteAlarm();

  const [editing, setEditing] = useState<WidgetAlarm | null>(null);
  const [lens, setLens] = useState<Lens>("alarms");

  const widgetById = useMemo(() => new Map((widgets ?? []).map(w => [w.id, w])), [widgets]);
  const groupById = useMemo(() => new Map((groups ?? []).map(g => [g.id, g])), [groups]);

  const rows = useMemo(
    () => [...(alarms ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
    [alarms]);

  // Two sections rather than two tabs: they are one list of what is being
  // watched, and a tab would hide half of it behind a click on a page whose
  // whole job is to be scanned. The split is by what an alarm watches, which is
  // also what decides who may change it.
  const githubRows = useMemo(
    () => rows.filter(a => !a.widgetId.startsWith("guardrail:")), [rows]);
  const awsRows = useMemo(
    () => rows.filter(a => a.widgetId.startsWith("guardrail:")), [rows]);

  const firing = rows.filter(a => a.state === "ALARM" && a.enabled);
  const paused = rows.filter(a => !a.enabled);
  const unreadable = rows.filter(a => a.enabled && a.lastError);

  if (!isAdmin) {
    return (
      <Page user={user}>
        <PageHeader title="Alarms" subtitle="Thresholds on widgets and AWS guardrails, and who hears about them." />
        <Empty
          title="Admins only"
          body={`Alarms notify the whole organization, so they are managed by `
            + `members of the "${permissions?.adminTeam ?? "admin"}" and `
            + `"${permissions?.awsAdminTeam ?? "admin"}" teams, and by organization owners.`}
        />
      </Page>
    );
  }

  return (
    <Page user={user}>
      <PageHeader
        title="Alarms"
        subtitle="Thresholds on widgets and AWS guardrails, and who hears about them."
        actions={<RefreshButton busy={isFetching} onRefresh={() => refetch()} />}
      />

      <div className="mb-5">
        <Segmented value={lens} onChange={v => setLens(v as Lens)}
          options={[["alarms", `Alarms${rows.length ? ` (${rows.length})` : ""}`],
                    ["groups", "Groups"]]} />
      </div>

      {lens === "groups" ? <EmailGroupsPanel /> : isLoading ? (
        <div className="py-20 flex justify-center"><Spinner /></div>
      ) : isError ? (
        <LoadFailed what="your alarms" error={error} onRetry={() => refetch()} />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing is being watched"
          body="Open a widget on the Overview page, or an AWS guardrail rule, and add an alarm to it. Alarms check on their own schedule and tell a group when a number crosses a line."
          action={<Button variant="primary" onClick={() => navigate("/analytics")}>Go to Overview</Button>}
        />
      ) : (
        <div className="grid gap-4">
          {/* ── the one question this page exists to answer ───────────
              A flat list makes you read every row to find out whether
              anything is wrong. This says it before the list starts. */}
          <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
            <div className={`${SURFACE.card} relative overflow-hidden px-6 py-5`}>
              <div aria-hidden="true"
                className={`pointer-events-none absolute -right-16 -top-16 w-56 h-56 rounded-full blur-2xl opacity-[0.16]
                  ${firing.length ? "bg-rose-500" : "bg-emerald-500"}`} />
              <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Currently firing</div>
              <div className="flex items-end gap-3 mt-2.5">
                <span className={`text-[52px] font-black tabular-nums leading-[0.85] tracking-[-0.04em]
                  ${firing.length ? "text-rose-600 dark:text-rose-400" : "text-slate-300 dark:text-slate-600"}`}>
                  {firing.length}
                </span>
                {firing.length === 0 && (
                  <span className="mb-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold
                                   bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                    <i className="ph-bold ph-check text-[12px]" aria-hidden="true" />all clear
                  </span>
                )}
              </div>
              <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-2.5">
                {firing.length === 0
                  ? `${rows.length - paused.length} watching, nothing over its threshold.`
                  : `${firing.length === 1 ? "One alarm is" : `${firing.length} alarms are`} over their threshold.`}
              </p>
            </div>

            <div className={`${SURFACE.card} overflow-hidden grid gap-px bg-slate-200/70 dark:bg-white/[0.07]`}>
              <div className="bg-white dark:bg-[#151a23] px-5 py-4 flex items-center gap-4">
                <i className={`ph-fill ph-pause-circle text-[19px] ${paused.length ? "text-slate-500" : "text-slate-300 dark:text-slate-600"}`} aria-hidden="true" />
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[22px] font-black tabular-nums leading-none ${paused.length ? "text-slate-900 dark:text-white" : "text-slate-300 dark:text-slate-600"}`}>{paused.length}</span>
                    <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">Paused</span>
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">watching nothing while paused</p>
                </div>
              </div>
              {/* Its own number, because an alarm that cannot take a reading is
                  not a passing alarm and does not belong in either count above. */}
              <div className="bg-white dark:bg-[#151a23] px-5 py-4 flex items-center gap-4">
                <i className={`ph-fill ph-warning-circle text-[19px] ${unreadable.length ? "text-amber-500" : "text-slate-300 dark:text-slate-600"}`} aria-hidden="true" />
                <div>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-[22px] font-black tabular-nums leading-none ${unreadable.length ? "text-slate-900 dark:text-white" : "text-slate-300 dark:text-slate-600"}`}>{unreadable.length}</span>
                    <span className="text-[12px] font-bold text-slate-600 dark:text-slate-300">Cannot read</span>
                  </div>
                  <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                    {unreadable.length ? "not the same as passing" : "every check took a reading"}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {([
            {
              key: "github", rows: githubRows, canEdit: canSeeGithub,
              title: "On GitHub widgets", icon: "ph-git-branch",
              team: permissions?.adminTeam,
              blurb: "Thresholds on the checks from the Overview board.",
              none: "No alarm watches a widget yet. Open one on Overview and set a number on it.",
            },
            {
              key: "aws", rows: awsRows, canEdit: canSeeAws,
              title: "On AWS guardrails", icon: "ph-shield-check",
              team: permissions?.awsAdminTeam,
              blurb: "Thresholds on guardrail findings, in the AWS account.",
              none: "No alarm watches a guardrail yet. Open a rule on the AWS tab and set a number on it.",
            },
          ] as const).map(section => (
            <section key={section.key} className={`${SURFACE.card} overflow-hidden`}>
              <div className="px-5 pt-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <i className={`ph-bold ${section.icon} text-[14px] text-slate-400 dark:text-slate-500`}
                    aria-hidden="true" />
                  <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-white">
                    {section.title}
                  </h3>
                  <span className="text-[11px] font-bold tabular-nums text-slate-300 dark:text-slate-600">
                    {section.rows.length}
                  </span>
                  {/* Read-only is said once, at the top, rather than implied by
                      a row whose controls quietly never appear. */}
                  {!section.canEdit && (
                    <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded
                                     text-[10.5px] font-bold bg-slate-100 dark:bg-white/[0.08]
                                     text-slate-500 dark:text-slate-400">
                      <i className="ph-fill ph-lock-simple text-[9px]" aria-hidden="true" />
                      view only · {section.team ?? "admin"}
                    </span>
                  )}
                </div>
                <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                  {section.blurb} Firing first, then paused.
                </p>
                <div className="h-px bg-slate-200/70 dark:bg-white/[0.07] mt-3" />
              </div>

              {section.rows.length === 0 ? (
                <p className="px-5 py-6 text-[12.5px] text-slate-400 dark:text-slate-500">
                  {section.none}
                </p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-white/[0.06]">
                  {section.rows.map(a => {
                    const guardrail = a.widgetId.startsWith("guardrail:");
                    const widget = guardrail ? undefined : widgetById.get(a.widgetId);
                    return (
                      <AlarmRow
                        key={a.id}
                        alarm={a}
                        subject={subjectOf(a, widget?.title)}
                        groupName={groupById.get(a.groupId)?.name}
                        interval={a.intervalMinutes ?? null}
                        canEdit={section.canEdit}
                        onEdit={() => setEditing(a)}
                        onToggle={() => updateAlarm.mutate({ id: a.id, data: { enabled: !a.enabled } })}
                        onDelete={() => {
                          if (confirm(`Delete "${a.name}"? Nothing will be watching that number.`)) {
                            deleteAlarm.mutate(a.id);
                          }
                        }}
                      />
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {editing && (
        <AlarmModal isOpen widgetId={editing.widgetId} existing={editing}
          onClose={() => setEditing(null)} />
      )}
    </Page>
  );
}
