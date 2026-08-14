import { useState, useEffect } from "react";
import {
  useEmailGroups, useSecuritySettings, useTemplateVariables,
  useCreateGroup, useDeleteGroup, useAddGroupMember, useRemoveGroupMember,
  useTestGroup, useSaveSecuritySettings,
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
 * Email groups and the security-alert toggle.
 *
 * A group is an SNS topic. Membership is read back from SNS rather than from
 * our own table, so an address that never clicked its confirmation link shows
 * as pending — it receives nothing, and showing it as a member would make a
 * silently undelivered alert look like a delivered one.
 */
export default function NotificationsPanel({ isAdmin }: { isAdmin: boolean }) {
  const { data: groups, isLoading: groupsLoading } = useEmailGroups(isAdmin);
  const { data: settings } = useSecuritySettings(isAdmin);
  const { data: variables } = useTemplateVariables(isAdmin);

  const createGroup = useCreateGroup();
  const deleteGroup = useDeleteGroup();
  const addMember = useAddGroupMember();
  const removeMember = useRemoveGroupMember();
  const testGroup = useTestGroup();
  const saveSettings = useSaveSecuritySettings();

  const [newGroup, setNewGroup] = useState("");
  const [emailFor, setEmailFor] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("high");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

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

  async function run(fn: () => Promise<any>, ok?: string) {
    setError(""); setNotice("");
    try {
      const res: any = await fn();
      setNotice(ok ?? res?.message ?? "Done");
    } catch (err: any) {
      setError(err?.message || "That did not work.");
    }
  }

  async function saveSecurity(next: Partial<{ enabled: boolean; groupId: string; minSeverity: Severity; subjectTemplate: string; bodyTemplate: string }>) {
    await run(() => saveSettings.mutateAsync({
      enabled, groupId, minSeverity, subjectTemplate: subject, bodyTemplate: body, ...next,
    }), "Saved");
  }

  return (
    <div className="space-y-5">
      {(notice || error) && (
        <div className={`rounded-md px-4 py-3 text-sm ${error
          ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300"
          : "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"}`}>
          {error || notice}
        </div>
      )}

      {/* ── the toggle ── */}
      <div className={cardClass}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-gray-900 dark:text-white">Email me about security alerts</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-400 max-w-2xl">
              Sends within seconds of the event — a repository going public, branch protection
              being removed, a team's permissions changing. This is driven by the webhook, not by
              a schedule, so it does not wait for the next check.
            </p>
          </div>
          <button
            onClick={() => { const next = !enabled; setEnabled(next); saveSecurity({ enabled: next }); }}
            disabled={!enabled && !groupId}
            title={!enabled && !groupId ? "Choose an email group first" : ""}
            className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-40 ${
              enabled ? "bg-gh-blue" : "bg-gray-300 dark:bg-slate-600"}`}>
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              enabled ? "translate-x-6" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Send to</label>
            <select value={groupId} className={inputClass}
              onChange={e => { setGroupId(e.target.value); saveSecurity({ groupId: e.target.value }); }}>
              <option value="">Choose a group…</option>
              {(groups ?? []).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Only at or above</label>
            <select value={minSeverity} className={inputClass}
              onChange={e => { const v = e.target.value as Severity; setMinSeverity(v); saveSecurity({ minSeverity: v }); }}>
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
                onBlur={() => saveSecurity({ subjectTemplate: subject })} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Body</label>
              <textarea value={body} rows={6} onChange={e => setBody(e.target.value)}
                onBlur={() => saveSecurity({ bodyTemplate: body })}
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

      {/* ── groups ── */}
      <div className={cardClass}>
        <h3 className="text-base font-bold text-gray-900 dark:text-white">Email groups</h3>
        <p className="mt-1 text-sm text-gray-600 dark:text-slate-400">
          Each group is an AWS SNS topic. Everyone you add gets a one-time confirmation email from
          AWS and receives nothing until they click it.
        </p>

        <div className="mt-4 flex gap-2">
          <input value={newGroup} onChange={e => setNewGroup(e.target.value)}
            placeholder="Group name, e.g. Security on-call" className={inputClass} />
          <button
            onClick={() => run(async () => { await createGroup.mutateAsync(newGroup); setNewGroup(""); }, "Group created")}
            disabled={!newGroup.trim() || createGroup.isPending}
            className="shrink-0 px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-50">
            Add group
          </button>
        </div>

        {groupsLoading && <p className="mt-4 text-sm text-gray-500 dark:text-slate-400">Loading…</p>}

        <div className="mt-4 space-y-4">
          {(groups ?? []).map(g => (
            <div key={g.id} className="rounded-md border border-gh-border dark:border-slate-700 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-gh-textBase dark:text-slate-100">{g.name}</div>
                <div className="flex gap-2">
                  <button onClick={() => run(() => testGroup.mutateAsync(g.id))}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200">
                    Send test
                  </button>
                  <button onClick={() => run(() => deleteGroup.mutateAsync({ id: g.id }), "Group deleted")}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40">
                    Delete
                  </button>
                </div>
              </div>

              {g.membersError && (
                <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                  Could not read this group's members: {g.membersError}
                </p>
              )}

              <ul className="mt-3 space-y-1">
                {g.members.map(m => (
                  <li key={m.subscriptionArn + m.endpoint}
                    className="flex items-center justify-between text-sm text-gh-textBase dark:text-slate-300">
                    <span>
                      {m.endpoint}
                      {!m.confirmed && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300">
                          pending — receives nothing yet
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => run(() => removeMember.mutateAsync({ id: g.id, subscriptionArn: m.subscriptionArn }), "Removed")}
                      className="text-xs text-gray-500 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400">
                      Remove
                    </button>
                  </li>
                ))}
                {g.members.length === 0 && !g.membersError && (
                  <li className="text-sm text-gray-500 dark:text-slate-400">Nobody yet.</li>
                )}
              </ul>

              <div className="mt-3 flex gap-2">
                <input type="email" placeholder="name@example.com" className={inputClass}
                  value={emailFor[g.id] ?? ""}
                  onChange={e => setEmailFor({ ...emailFor, [g.id]: e.target.value })} />
                <button
                  onClick={() => run(async () => {
                    const res = await addMember.mutateAsync({ id: g.id, email: emailFor[g.id] ?? "" });
                    setEmailFor({ ...emailFor, [g.id]: "" });
                    return res;
                  })}
                  disabled={!(emailFor[g.id] ?? "").trim()}
                  className="shrink-0 px-3 py-2 text-sm font-semibold rounded-md border border-gh-border dark:border-slate-600 hover:bg-black/5 dark:hover:bg-white/5 text-gh-textBase dark:text-slate-200 disabled:opacity-50">
                  Add
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
