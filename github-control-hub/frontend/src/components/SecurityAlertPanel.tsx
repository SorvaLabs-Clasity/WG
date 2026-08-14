import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  useEmailGroups, useSecuritySettings, useTemplateVariables, useSaveSecuritySettings,
} from "../hooks/useAlarms";
import type { Severity } from "../api/alarms";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";
const labelClass = "block text-sm font-semibold text-gh-textBase dark:text-slate-200 mb-1";
const cardClass =
  "bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5";

/**
 * The security-alert toggle: chooses among existing groups, never makes one.
 *
 * Group creation lives on the Alarms page. Offering it here as well would mean
 * two screens producing SNS topics, and a set of recipients nobody can find
 * again.
 */
export default function SecurityAlertPanel({ isAdmin }: { isAdmin: boolean }) {
  const { data: groups } = useEmailGroups(isAdmin);
  const { data: settings } = useSecuritySettings(isAdmin);
  const { data: variables } = useTemplateVariables(isAdmin);
  const saveSettings = useSaveSecuritySettings();

  const [enabled, setEnabled] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("high");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setGroupId(settings.groupId ?? "");
    setMinSeverity(settings.minSeverity);
    setSubject(settings.subjectTemplate);
    setBody(settings.bodyTemplate);
  }, [settings]);

  if (!isAdmin) {
    return (
      <div className={cardClass}>
        <p className="text-sm text-gray-600 dark:text-slate-400">
          Notification settings are managed by organisation admins. They send mail on behalf of the
          whole organisation, so they are not scoped to what you personally can reach.
        </p>
      </div>
    );
  }

  async function save(next: Partial<{
    enabled: boolean; groupId: string; minSeverity: Severity;
    subjectTemplate: string; bodyTemplate: string;
  }>) {
    setError(""); setNotice("");
    try {
      await saveSettings.mutateAsync({
        enabled, groupId, minSeverity, subjectTemplate: subject, bodyTemplate: body, ...next,
      });
      setNotice("Saved");
    } catch (err: any) {
      setError(err?.message || "Could not save that.");
    }
  }

  const noGroups = (groups ?? []).length === 0;

  return (
    <div className="space-y-4">
      {(notice || error) && (
        <div className={`rounded-md px-4 py-3 text-sm ${error
          ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
          : "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"}`}>
          {error || notice}
        </div>
      )}

      <div className={cardClass}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-white">Email me about security alerts</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-400 max-w-2xl">
              Sends within seconds of the event — a repository going public, branch protection being
              removed, a team's permissions changing. Driven by the webhook, not by a schedule, so
              it does not wait for the next check.
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {/* The state, in a word. Choosing a group saves that choice but does
                not switch anything on, and a toggle whose position is the only
                clue reads as "configured" once the dropdown is filled in. */}
            <span className={`text-xs font-bold uppercase tracking-wide ${
              enabled ? "text-green-600 dark:text-green-400" : "text-gray-400 dark:text-slate-500"}`}>
              {enabled ? "On" : "Off"}
            </span>
            <button
              onClick={() => { const next = !enabled; setEnabled(next); save({ enabled: next }); }}
              disabled={!enabled && !groupId}
              title={!enabled && !groupId ? "Choose an email group first" : ""}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 ${
                enabled ? "bg-gh-blue" : "bg-gray-300 dark:bg-slate-600"}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
        </div>

        {/* A group chosen while this is off is the state that looks finished
            and sends nothing. Say so where the eye already is. */}
        {!enabled && groupId && (
          <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            A group is selected but this is <strong>off</strong> — alerts are being recorded and
            nobody is emailed. Use the switch above to start sending.
          </div>
        )}
        {enabled && groupId && (
          <div className="mt-3 rounded-md bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm text-green-800 dark:text-green-300">
            Sending {minSeverity} and above to{" "}
            <strong>{groups?.find(g => g.id === groupId)?.name ?? "the selected group"}</strong>
            {(() => {
              const g = groups?.find(x => x.id === groupId);
              if (!g) return null;
              const ok = g.members.filter(m => m.confirmed).length;
              const pending = g.members.length - ok;
              return <> — {ok} confirmed recipient{ok === 1 ? "" : "s"}
                {pending > 0 && <>, {pending} still pending and receiving nothing</>}
                {ok === 0 && <strong> — nobody will receive these until someone confirms</strong>}
              </>;
            })()}
          </div>
        )}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Send to</label>
            {noGroups ? (
              <p className="text-sm text-amber-700 dark:text-amber-400">
                No email groups yet — create one on the{" "}
                <Link to="/alarms" className="font-semibold underline">Alarms</Link> page first.
              </p>
            ) : (
              <select value={groupId} className={inputClass}
                onChange={e => { setGroupId(e.target.value); save({ groupId: e.target.value }); }}>
                <option value="">Choose a group…</option>
                {groups!.map(g => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.members.filter(m => m.confirmed).length} confirmed)
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className={labelClass}>Only at or above</label>
            <select value={minSeverity} className={inputClass}
              onChange={e => { const v = e.target.value as Severity; setMinSeverity(v); save({ minSeverity: v }); }}>
              {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              Lower-severity alerts are still recorded, just not emailed.
            </p>
          </div>
        </div>

        <button type="button" onClick={() => setShowTemplates(v => !v)}
          className="mt-4 text-sm font-semibold text-gh-blue hover:underline">
          <i className={`ph ph-caret-${showTemplates ? "down" : "right"} mr-1`}></i>
          Customise the email
        </button>

        {showTemplates && (
          <div className="mt-3 space-y-3">
            <div>
              <label className={labelClass}>Subject</label>
              <input value={subject} onChange={e => setSubject(e.target.value)}
                onBlur={() => save({ subjectTemplate: subject })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Body</label>
              <textarea value={body} rows={6} onChange={e => setBody(e.target.value)}
                onBlur={() => save({ bodyTemplate: body })}
                className={inputClass + " font-mono text-xs"} />
            </div>
            {variables && (
              <div className="text-xs text-gray-500 dark:text-slate-400">
                <span className="font-semibold">Variables: </span>
                {variables.map(v => (
                  <code key={v.name} title={v.description}
                    className="mr-2 px-1 py-0.5 rounded bg-black/5 dark:bg-white/10">{`{{${v.name}}}`}</code>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
