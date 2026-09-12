import { useState, useEffect, useMemo } from "react";
import {
  useWidgetConditions, useEmailGroups, useTemplateVariables,
  useCreateAlarm, useUpdateAlarm,

  useCreateMyAlarm, useUpdateMyAlarm, useMyDestination,
} from "../hooks/useAlarms";
import { describeInterval, type AlarmCondition, type Severity, type WidgetAlarm } from "../api/alarms";
import VariableChips, { useTemplateInsert } from "./TemplateVariables";
import TeamsWording from "./TeamsWording";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const inputClass = "field-line text-[13.5px]";
const labelClass = "caps block mb-1.5";

/**
 * Configure one alarm on one widget.
 *
 * The condition list comes from the server rather than being hard-coded here,
 * so a widget only ever offers thresholds it can actually produce, and the
 * same catalogue is what the API validates against, which means the form
 * cannot construct a request the server will refuse.
 */
export default function AlarmModal({
  isOpen, onClose, widgetId, existing, personal = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  widgetId: string;
  existing?: WidgetAlarm | null;
  /**
   * An alarm on somebody's own card, delivered to their own address.
   *
   * One form for both, because everything that is hard here — which conditions
   * a widget supports, what the templates may say, what the interval means — is
   * identical, and a second copy would be the one that goes stale. What differs
   * is the destination: an organization alarm picks a group, and a personal one
   * has exactly one, resolved by the server from who is asking. There is
   * deliberately no control for it, since offering a choice would mean sending
   * a group id, which is what the server refuses.
   */
  personal?: boolean;
}) {
  const { data: spec, isLoading } = useWidgetConditions(isOpen ? widgetId : null);
  const { data: groups } = useEmailGroups(isOpen && !personal);
  const { data: destination } = useMyDestination(isOpen && personal);
  const { data: variables } = useTemplateVariables(isOpen);
  const createOrg = useCreateAlarm();
  const updateOrg = useUpdateAlarm();
  const createMine = useCreateMyAlarm();
  const updateMine = useUpdateMyAlarm();
  const createAlarm = personal ? createMine : createOrg;
  const updateAlarm = personal ? updateMine : updateOrg;

  const [name, setName] = useState("");
  const [metric, setMetric] = useState("");
  const [op, setOp] = useState<"gte" | "lte">("gte");
  const [threshold, setThreshold] = useState("1");
  const [atLeast, setAtLeast] = useState<Severity>("high");
  const [groupId, setGroupId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [teams, setTeams] = useState({ subject: "", body: "" });
  const [notifyOnRecovery, setNotifyOnRecovery] = useState(true);
  const [showTemplates, setShowTemplates] = useState(false);
  const [error, setError] = useState("");

  const tpl = useTemplateInsert(subject, setSubject, body, setBody);

  /**
   * The selection is `kind:metric`, not the metric alone.
   *
   * "Every new matching row" and "matching rows is at or above N" are the same
   * metric read two different ways, so keying the dropdown on the metric gave
   * two options with one value and made the first unselectable.
   */
  const chosen = useMemo(
    () => spec?.conditions.find(c => `${c.kind}:${c.metric}` === metric),
    [spec, metric],
  );

  useEffect(() => {
    if (!isOpen || !spec) return;
    setError("");
    if (existing) {
      setName(existing.name);
      setMetric(`${existing.condition.kind}:${existing.condition.metric}`);
      if (existing.condition.kind === "count") {
        setOp(existing.condition.op);
        setThreshold(String(existing.condition.threshold));
      } else if (existing.condition.kind === "severity") {
        setAtLeast(existing.condition.atLeast);
      }
      setGroupId(existing.groupId);
      setSubject(existing.subjectTemplate);
      setBody(existing.bodyTemplate);
      setTeams({
        subject: existing.teamsSubjectTemplate ?? "",
        body: existing.teamsBodyTemplate ?? "",
      });
      setNotifyOnRecovery(existing.notifyOnRecovery);
    } else {
      setName(spec.title || "Alarm");
      const first = spec.conditions[0];
      setMetric(first ? `${first.kind}:${first.metric}` : "");
      setOp("gte");
      setThreshold("1");
      setAtLeast("high");
      setGroupId(groups?.[0]?.id ?? "");
      const wording = first?.kind === "each" && spec.eachDefaults
        ? spec.eachDefaults : spec.defaults;
      setSubject(wording.subject);
      setBody(wording.body);
      setNotifyOnRecovery(true);
    }
  }, [isOpen, spec, existing, groups]);

  /**
   * Follow the reading, until somebody has written their own words.
   *
   * The two readings want different wording: a threshold template on an alarm
   * with no threshold ends "your limit is undefined". Switching the dropdown
   * has to bring its text with it, but only while the text is still one of the
   * defaults, or changing the dropdown would throw away a message somebody had
   * spent time on.
   */
  const untouched = useMemo(() => {
    if (!spec) return false;
    const known = [spec.defaults, spec.eachDefaults].filter(Boolean) as
      { subject: string; body: string }[];
    return known.some(d => d.subject === subject && d.body === body);
  }, [spec, subject, body]);

  useEffect(() => {
    if (!isOpen || !spec || existing || !chosen || !untouched) return;
    const wording = chosen.kind === "each" && spec.eachDefaults
      ? spec.eachDefaults : spec.defaults;
    setSubject(wording.subject);
    setBody(wording.body);
  }, [isOpen, spec, existing, chosen, untouched]);

  if (!isOpen) return null;

  function buildCondition(): AlarmCondition | null {
    if (!chosen) return null;
    if (chosen.kind === "severity") {
      return { kind: "severity", metric: "vulnRepos.worstSeverity", atLeast };
    }
    // No number to carry: the metric rides along only so the message can still
    // say how many there are in total.
    if (chosen.kind === "each") {
      return { kind: "each", metric: chosen.metric as any };
    }
    const n = Number(threshold);
    if (!Number.isFinite(n)) return null;
    return { kind: "count", metric: chosen.metric, op, threshold: n };
  }

  async function save() {
    setError("");
    const condition = buildCondition();
    if (!condition) return setError("Choose a condition and a number.");
    if (!personal && !groupId) return setError("Choose who to email.");

    const payload = {
      widgetId, name, condition,
      // Omitted entirely on a personal alarm. The server resolves the
      // destination from the session and refuses a supplied one.
      ...(personal ? {} : { groupId }),
      subjectTemplate: subject, bodyTemplate: body,
      teamsSubjectTemplate: teams.subject, teamsBodyTemplate: teams.body,
      notifyOnRecovery,
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
      <div className="absolute inset-0 bg-ink/40 -[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-paper rounded-none shadow-modal border border-black/10 dark:border-rule w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">

        <div className="px-6 py-4 border-b border-rule dark:border-rule flex items-center justify-between shrink-0 rounded-t-[12px]">
          <h3 className="text-lg font-bold text-gray-900 dark:text-ink tracking-tight">
            {existing ? "Edit alarm" : "New alarm"}
          </h3>
          <button onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 dark:text-slate-500 hover:text-gray-900 dark:hover:text-ink hover:bg-black/5 dark:hover:bg-ink/5 transition-colors">
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
                      <option key={`${c.kind}:${c.metric}`} value={`${c.kind}:${c.metric}`}>
                        {c.label}
                      </option>
                    ))}
                  </select>

                  {/* Nothing to configure. The whole point of this option is
                      that there is no number to choose, so showing a disabled
                      comparison beside it would only invite the question. */}
                  {chosen?.kind === "each" ? (
                    <span className="self-center text-sm text-gray-600 dark:text-slate-400">
                      — told once about each new one, as it appears
                    </span>
                  ) : chosen?.kind === "severity" ? (
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
                {/* The tick is the worst case, not the usual one, for a
                    guardrail: whatever rewrites the findings evaluates the
                    alarms reading them in the same invocation. Saying only
                    "up to 5 minutes" hides that. */}
                <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">
                  {widgetId.startsWith("guardrail:")
                    ? <>Checked whenever the findings change, so a sweep, a resource changing,
                        Run, or an exclusion edit all notice at once. The {describeInterval(spec.intervalMinutes)}{" "}
                        pass is the backstop.</>
                    : <>Checked {describeInterval(spec.intervalMinutes)}, so this can take up to{" "}
                        {spec.intervalMinutes} minutes to notice.</>}
                </p>
              </div>

              <div>
                <label className={labelClass}>{personal ? "Where this goes" : "Email"}</label>
                {personal ? (
                  <PersonalDestinationSummary destination={destination} />
                ) : groups && groups.length > 0 ? (
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
                    No email groups yet. Create one under Security → Notifications first.
                  </p>
                )}
              </div>

              {/* The asymmetry is stated, because it is the thing people ask
                  about: firing is immediate and recovery is not, deliberately. */}
              <label className="flex items-start gap-2 text-sm text-gh-textBase dark:text-slate-200">
                <input type="checkbox" checked={notifyOnRecovery} className="mt-0.5"
                  onChange={e => setNotifyOnRecovery(e.target.checked)} />
                <span>
                  Tell me when it returns to normal
                  <span className="block text-[12px] text-gray-500 dark:text-slate-400 mt-0.5">
                    Sent to the same group, by email and Teams. It waits for two clean checks
                    in a row, so a value resting on its threshold does not send an all-clear
                    every time it wobbles. Going wrong waits for nothing.
                  </span>
                </span>
              </label>

              <div>
                <button type="button" onClick={() => setShowTemplates(v => !v)}
                  className="text-sm font-semibold text-gh-blue hover:underline">
                  <i className={`ph ph-caret-${showTemplates ? "down" : "right"} mr-1`}></i>
                  Customise the message
                </button>

                {showTemplates && (
                  <div className="mt-3 space-y-3">
                    <div>
                      <label className={labelClass}>Subject</label>
                      <input {...tpl.subjectProps} value={subject}
                        onChange={e => setSubject(e.target.value)} className={inputClass} />
                      <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                        Trimmed to 99 characters and to plain ASCII, because that is all AWS will accept.
                      </p>
                    </div>
                    <div>
                      <label className={labelClass}>Body</label>
                      <textarea {...tpl.bodyProps} value={body}
                        onChange={e => setBody(e.target.value)} rows={7}
                        className={inputClass + " font-mono text-xs"} />
                    </div>
                    <VariableChips variables={variables} target={tpl.target} onInsert={tpl.insert} />

                    <TeamsWording
                      subject={teams.subject} body={teams.body} onChange={setTeams}
                      variables={variables} emailSubject={subject} emailBody={body}
                    />
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

        <div className="px-6 py-4 border-t border-rule dark:border-rule flex justify-end gap-2 shrink-0">
          <button onClick={onClose}
            className="px-4 py-2 text-sm font-semibold rounded-md text-gh-textBase dark:text-slate-200 hover:bg-black/5 dark:hover:bg-ink/5">
            Cancel
          </button>
          <button onClick={save} disabled={saving || !spec?.conditions.length}
            className="px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-reverse hover:opacity-90 disabled:opacity-50">
            {saving ? "Saving…" : existing ? "Save changes" : "Create alarm"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Where a personal alarm lands, stated rather than chosen.
 *
 * Read-only on purpose: the addresses are managed in one place, on the Alarms
 * tab, so somebody with four alarms has one list to keep rather than four. What
 * this has to do is make the silence explainable — an address that has not
 * confirmed receives nothing, and a form that showed it as a destination would
 * leave somebody waiting for an email that was never going to arrive.
 */
function PersonalDestinationSummary({ destination }: {
  destination?: { emails: { endpoint: string; confirmed: boolean }[]; teams: string[] };
}) {
  const confirmed = (destination?.emails ?? []).filter(e => e.confirmed);
  const pending = (destination?.emails ?? []).filter(e => !e.confirmed);
  const teams = destination?.teams ?? [];

  if (confirmed.length === 0 && teams.length === 0) {
    return (
      <p className="text-sm text-amber-700 dark:text-amber-400">
        {pending.length > 0
          ? `${pending.length} address${pending.length > 1 ? "es have" : " has"} not confirmed yet, `
            + "so nothing can be delivered. Check for the confirmation email from AWS."
          : "You have not added an address yet. Add one on the Alarms tab and this "
            + "alarm will reach you."}
      </p>
    );
  }

  return (
    <div className="text-sm text-slate-600 dark:text-slate-300">
      {confirmed.map(e => (
        <div key={e.endpoint} className="flex items-center gap-1.5">
          <i className="ph-bold ph-envelope-simple text-[12px] text-slate-400" aria-hidden="true" />
          <span className="font-mono text-[12.5px]">{e.endpoint}</span>
        </div>
      ))}
      {teams.map(a => (
        <div key={a} className="flex items-center gap-1.5">
          <i className="ph-bold ph-chat-teardrop-text text-[12px] text-violet-500" aria-hidden="true" />
          <span className="font-mono text-[12.5px]">{a}</span>
        </div>
      ))}
      {pending.length > 0 && (
        <p className="text-[12px] text-amber-700 dark:text-amber-400 mt-1">
          {pending.length} more waiting to confirm.
        </p>
      )}
    </div>
  );
}
