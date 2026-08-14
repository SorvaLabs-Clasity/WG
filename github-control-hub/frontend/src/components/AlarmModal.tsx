import { useState, useEffect, useMemo } from "react";
import {
  useWidgetConditions, useEmailGroups, useTemplateVariables,
  useCreateAlarm, useUpdateAlarm,
} from "../hooks/useAlarms";
import { describeInterval, type AlarmCondition, type Severity, type WidgetAlarm } from "../api/alarms";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";
const labelClass = "block text-sm font-semibold text-gh-textBase dark:text-slate-200 mb-1";

/**
 * Configure one alarm on one widget.
 *
 * The condition list comes from the server rather than being hard-coded here,
 * so a widget only ever offers thresholds it can actually produce — and the
 * same catalogue is what the API validates against, which means the form
 * cannot construct a request the server will refuse.
 */
export default function AlarmModal({
  isOpen, onClose, widgetId, existing,
}: {
  isOpen: boolean;
  onClose: () => void;
  widgetId: string;
  existing?: WidgetAlarm | null;
}) {
  const { data: spec, isLoading } = useWidgetConditions(isOpen ? widgetId : null);
  const { data: groups } = useEmailGroups(isOpen);
  const { data: variables } = useTemplateVariables(isOpen);
  const createAlarm = useCreateAlarm();
  const updateAlarm = useUpdateAlarm();

  const [name, setName] = useState("");
  const [metric, setMetric] = useState("");
  const [op, setOp] = useState<"gte" | "lte">("gte");
  const [threshold, setThreshold] = useState("1");
  const [atLeast, setAtLeast] = useState<Severity>("high");
  const [groupId, setGroupId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [notifyOnRecovery, setNotifyOnRecovery] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [error, setError] = useState("");

  const chosen = useMemo(
    () => spec?.conditions.find(c => c.metric === metric),
    [spec, metric],
  );

  useEffect(() => {
    if (!isOpen || !spec) return;
    setError("");
    if (existing) {
      setName(existing.name);
      setMetric(existing.condition.metric);
      if (existing.condition.kind === "count") {
        setOp(existing.condition.op);
        setThreshold(String(existing.condition.threshold));
      } else {
        setAtLeast(existing.condition.atLeast);
      }
      setGroupId(existing.groupId);
      setSubject(existing.subjectTemplate);
      setBody(existing.bodyTemplate);
      setNotifyOnRecovery(existing.notifyOnRecovery);
    } else {
      setName(spec.title || "Alarm");
      setMetric(spec.conditions[0]?.metric ?? "");
      setOp("gte");
      setThreshold("1");
      setAtLeast("high");
      setGroupId(groups?.[0]?.id ?? "");
      setSubject(spec.defaults.subject);
      setBody(spec.defaults.body);
      setNotifyOnRecovery(true);
    }
  }, [isOpen, spec, existing, groups]);

  if (!isOpen) return null;

  function buildCondition(): AlarmCondition | null {
    if (!chosen) return null;
    if (chosen.kind === "severity") {
      return { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast };
    }
    const n = Number(threshold);
    if (!Number.isFinite(n)) return null;
    return { kind: "count", metric: chosen.metric, op, threshold: n };
  }

  async function save() {
    setError("");
    const condition = buildCondition();
    if (!condition) return setError("Choose a condition and a number.");
    if (!groupId) return setError("Choose who to email.");

    const payload = {
      widgetId, name, condition, groupId,
      subjectTemplate: subject, bodyTemplate: body, notifyOnRecovery,
    };
    try {
      if (existing) await updateAlarm.mutateAsync({ id: existing.id, data: payload });
      else await createAlarm.mutateAsync(payload);
      onClose();
    } catch (err: any) {
      setError(err?.message || "Could not save the alarm.");
    }
  }

  const saving = createAlarm.isPending || updateAlarm.isPending;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-[12px] shadow-modal border border-black/10 dark:border-slate-700 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">

        <div className="px-6 py-4 border-b border-gh-border dark:border-slate-700 flex items-center justify-between shrink-0 rounded-t-[12px]">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white tracking-tight">
            {existing ? "Edit alarm" : "New alarm"}
          </h3>
          <button onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 dark:text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-5">
          {isLoading && <p className="text-sm text-gray-500 dark:text-slate-400">Loading…</p>}

          {spec && spec.conditions.length === 0 && (
            <p className="text-sm text-amber-700 dark:text-amber-400">
              This widget does not expose anything that can be measured, so it cannot carry an alarm.
            </p>
          )}

          {spec && spec.conditions.length > 0 && (
            <>
              <div>
                <label className={labelClass}>Name</label>
                <input value={name} onChange={e => setName(e.target.value)} className={inputClass} />
              </div>

              <div>
                <label className={labelClass}>Email me when</label>
                <div className="flex flex-wrap gap-2">
                  <select value={metric} onChange={e => setMetric(e.target.value)}
                    className={inputClass + " flex-1 min-w-[12rem]"}>
                    {spec.conditions.map(c => (
                      <option key={c.metric} value={c.metric}>{c.label}</option>
                    ))}
                  </select>

                  {chosen?.kind === "severity" ? (
                    <>
                      <span className="self-center text-sm text-gray-600 dark:text-slate-400">reaches</span>
                      <select value={atLeast} onChange={e => setAtLeast(e.target.value as Severity)}
                        className={inputClass + " w-40"}>
                        {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </>
                  ) : (
                    <>
                      <select value={op} onChange={e => setOp(e.target.value as "gte" | "lte")}
                        className={inputClass + " w-44"}>
                        <option value="gte">is at or above</option>
                        <option value="lte">is at or below</option>
                      </select>
                      <input type="number" value={threshold} onChange={e => setThreshold(e.target.value)}
                        className={inputClass + " w-28"} />
                    </>
                  )}
                </div>
                {chosen?.hint && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">{chosen.hint}</p>
                )}
                <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">
                  Checked {describeInterval(spec.intervalMinutes)}, so this can take up to{" "}
                  {spec.intervalMinutes} minutes to notice.
                  {spec.intervalMinutes >= 60 &&
                    " Dependabot data only changes when GitHub rescans, so checking more often would not find it sooner."}
                </p>
              </div>

              <div>
                <label className={labelClass}>Email</label>
                {groups && groups.length > 0 ? (
                  <select value={groupId} onChange={e => setGroupId(e.target.value)} className={inputClass}>
                    <option value="">Choose a group…</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.members.filter(m => m.confirmed).length} confirmed)
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    No email groups yet — create one under Security → Notifications first.
                  </p>
                )}
              </div>

              <label className="flex items-center gap-2 text-sm text-gh-textBase dark:text-slate-200">
                <input type="checkbox" checked={notifyOnRecovery}
                  onChange={e => setNotifyOnRecovery(e.target.checked)} />
                Also email when it returns to normal
              </label>

              <div>
                <button type="button" onClick={() => setShowTemplates(v => !v)}
                  className="text-sm font-semibold text-gh-blue hover:underline">
                  <i className={`ph ph-caret-${showTemplates ? "down" : "right"} mr-1`}></i>
                  Customise the email
                </button>

                {showTemplates && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className={labelClass}>Subject</label>
                      <input value={subject} onChange={e => setSubject(e.target.value)} className={inputClass} />
                      <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                        Trimmed to 99 characters and to plain ASCII, because that is all AWS will accept.
                      </p>
                    </div>
                    <div>
                      <label className={labelClass}>Body</label>
                      <textarea value={body} onChange={e => setBody(e.target.value)} rows={7}
                        className={inputClass + " font-mono text-xs"} />
                    </div>
                    {variables && (
                      <div className="text-xs text-gray-500 dark:text-slate-400">
                        <span className="font-semibold">Variables: </span>
                        {variables.map(v => (
                          <code key={v.name} title={v.description}
                            className="mr-2 px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">
                            {`{{${v.name}}}`}
                          </code>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {error && (
                <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded-md px-3 py-2">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gh-border dark:border-slate-700 flex justify-end gap-2 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 text-sm font-semibold rounded-md text-gh-textBase dark:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !spec?.conditions.length}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
            {saving ? "Saving…" : existing ? "Save changes" : "Create alarm"}
          </button>
        </div>
      </div>
    </div>
  );
}
