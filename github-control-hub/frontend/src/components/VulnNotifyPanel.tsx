import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import {
  useEmailGroups, useTemplateVariables, useFeedSettings, useSaveFeedSettings,
} from "../hooks/useAlarms";
import type { Severity, NotifyFeed } from "../api/alarms";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

const inputClass =
  "block w-full rounded-md border-gh-border dark:border-slate-700 shadow-sm focus:border-gh-blue " +
  "focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset " +
  "ring-gray-300 dark:ring-slate-600 outline-none dark:bg-slate-800 dark:text-slate-200";
const labelClass = "block text-sm font-semibold text-gh-textBase dark:text-slate-200 mb-1";
const cardClass =
  "bg-white dark:bg-slate-900 rounded-[12px] border border-gh-border dark:border-slate-700 p-5";

/**
 * Everything that differs between the two feeds, in one place.
 *
 * The alternative was two components that drift: the same toggle, the same
 * group picker, the same template editor, diverging one fix at a time.
 */
const FEEDS: Record<NotifyFeed, {
  title: string;
  blurb: string;
  /** Only Dependabot has a severity to filter on. */
  severity: boolean;
  /** Shown when the toggle is on, to say what will actually arrive. */
  volume: string;
  /** A setup step this app cannot do for you, or null when there is none. */
  prerequisite: string | null;
}> = {
  "renovate-pr": {
    title: "Email me when Renovate opens a pull request",
    blurb: "One email per pull request, sent within seconds of it being opened. " +
      "Only pull requests from the bot account configured above — everything else " +
      "your team opens is ignored.",
    severity: false,
    volume: "The first time Renovate runs against a repository it can open many pull requests " +
      "at once, which is what grouping is for.",
    prerequisite: null,
  },
  "dependabot-alert": {
    title: "Email me when Dependabot finds a vulnerability",
    blurb: "One email per new alert, sent within seconds of GitHub raising it, rather " +
      "than waiting for the next scheduled check.",
    severity: true,
    volume: "Only alerts at or above the severity you choose, and only ones raised from now on — " +
      "switching this on does not send the backlog already in the table.",
    prerequisite: "This needs the Dependabot alert event on the webhook that feeds this app — " +
      "Organization → Settings → Webhooks → the Control Hub webhook → Edit, then tick " +
      "“Dependabot alerts” under “Let me select individual events”. It is the same webhook " +
      "and the same page used during setup. Until that is ticked nothing arrives here and " +
      "nothing reports an error, because GitHub never sends the event at all.",
  },
};

/**
 * A per-event email toggle, the same shape as the security one.
 *
 * Deliberately not an alarm. An alarm watches a number, fires when it crosses a
 * line and resolves when it comes back; these fire once per event and never
 * resolve, so putting them on the Alarms page would mean inventing a threshold
 * and a recovery for something that has neither.
 */
export default function VulnNotifyPanel({ feed, isAdmin }: { feed: NotifyFeed; isAdmin: boolean }) {
  const spec = FEEDS[feed];
  const { data: groups } = useEmailGroups(isAdmin);
  const { data: settings } = useFeedSettings(feed, isAdmin);
  const { data: variables } = useTemplateVariables(isAdmin);
  const saveSettings = useSaveFeedSettings(feed);

  const [enabled, setEnabled] = useState(false);
  const [groupId, setGroupId] = useState("");
  const [minSeverity, setMinSeverity] = useState<Severity>("high");
  const [grouping, setGrouping] = useState<"per-alert" | "per-repository">("per-repository");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [showTemplates, setShowTemplates] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setGroupId(settings.groupId ?? "");
    if (settings.minSeverity) setMinSeverity(settings.minSeverity);
    if (settings.grouping) setGrouping(settings.grouping);
    setSubject(settings.subjectTemplate);
    setBody(settings.bodyTemplate);
  }, [settings]);

  if (!isAdmin) {
    return (
      <div className={cardClass}>
        <p className="text-sm text-gray-600 dark:text-slate-400">
          Notification settings are managed by organization admins. They send mail on behalf of the
          whole organization, so they are not scoped to what you personally can reach.
        </p>
      </div>
    );
  }

  async function save(next: Partial<{
    enabled: boolean; groupId: string; minSeverity: Severity;
    grouping: "per-alert" | "per-repository";
    subjectTemplate: string; bodyTemplate: string;
  }>) {
    setError(""); setNotice("");
    try {
      await saveSettings.mutateAsync({
        enabled, groupId,
        // Sent only where it means something. The backend rejects it on the
        // Renovate feed rather than storing a filter it will never read.
        ...(spec.severity ? { minSeverity } : {}),
        grouping, subjectTemplate: subject, bodyTemplate: body, ...next,
      });
      setNotice("Saved");
    } catch (err: any) {
      setError(err?.message || "Could not save that.");
    }
  }

  const noGroups = (groups ?? []).length === 0;
  const group = groups?.find(g => g.id === groupId);

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
            <h3 className="text-base font-bold text-gray-900 dark:text-white">{spec.title}</h3>
            <p className="mt-1 text-sm text-gray-600 dark:text-slate-400 max-w-2xl">{spec.blurb}</p>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            {/* The state in a word, because a toggle whose position is the only
                clue reads as "configured" the moment a group is chosen. */}
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

        {/* Shown whether on or off. Somebody reading this before switching it on
            is exactly who needs to know it will not work without the step. */}
        {spec.prerequisite && (
          <div className="mt-3 rounded-md bg-slate-50 dark:bg-white/[0.04] px-3 py-2 text-sm text-gray-600 dark:text-slate-400">
            <i className="ph ph-info mr-1"></i>{spec.prerequisite}
          </div>
        )}

        {!enabled && groupId && (
          <div className="mt-3 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
            A group is selected but this is <strong>off</strong> — nobody is being emailed.
            Use the switch above to start sending.
          </div>
        )}
        {enabled && groupId && (
          <div className="mt-3 rounded-md bg-green-50 dark:bg-green-950/40 px-3 py-2 text-sm text-green-800 dark:text-green-300">
            Sending {spec.severity ? `${minSeverity} and above ` : ""}to{" "}
            <strong>{group?.name ?? "the selected group"}</strong>
            {group && (() => {
              const ok = group.members.filter(m => m.confirmed).length;
              const pending = group.members.length - ok;
              return <> — {ok} confirmed recipient{ok === 1 ? "" : "s"}
                {pending > 0 && <>, {pending} still pending and receiving nothing</>}
                {ok === 0 && <strong> — nobody will receive these until someone confirms</strong>}
              </>;
            })()}
          </div>
        )}

        <div className={`mt-4 grid gap-4 ${spec.severity ? "sm:grid-cols-2" : ""}`}>
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
          {spec.severity && (
            <div>
              <label className={labelClass}>Only at or above</label>
              <select value={minSeverity} className={inputClass}
                onChange={e => { const v = e.target.value as Severity; setMinSeverity(v); save({ minSeverity: v }); }}>
                {SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
                Lower-severity alerts still appear in the table above, just not by email.
              </p>
            </div>
          )}
        </div>

        <div className="mt-4 sm:w-1/2 sm:pr-2">
          <label className={labelClass}>Group emails</label>
          <select value={grouping} className={inputClass}
            onChange={e => {
              const v = e.target.value as "per-alert" | "per-repository";
              setGrouping(v); save({ grouping: v });
            }}>
            <option value="per-repository">One email per repository</option>
            <option value="per-alert">One email per {spec.severity ? "alert" : "pull request"}</option>
          </select>
          <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
            {grouping === "per-repository"
              ? "Events are held briefly and sent together, so switching Dependabot on for a "
                + "repository produces one email listing everything it found rather than one each. "
                + "Adds up to five minutes."
              : "Sends within seconds of each event. Enabling Dependabot on a repository with "
                + "twenty vulnerable dependencies sends twenty emails."}
          </p>
        </div>

        <p className="mt-3 text-xs text-gray-500 dark:text-slate-400">{spec.volume}</p>

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
                <p className="mt-1">
                  Times use the timezone set on the Security tab, which applies to every email
                  this app sends.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
