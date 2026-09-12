import { useTemplateInsert } from "./TemplateVariables";
import VariableChips from "./TemplateVariables";

/**
 * A second wording, for Teams, beside the email one.
 *
 * An email is opened deliberately and can carry a paragraph; a Teams message is
 * glanced at in a sidebar, where the first few words decide whether anybody
 * opens it. The same text is rarely right for both.
 *
 * Empty means "send the email wording", which is what anybody who does not want
 * two versions to keep in step should leave it as. A switch rather than two
 * more boxes always on screen, and turning it off clears both fields rather
 * than hiding them: a hidden value that is still being sent is the kind of
 * thing nobody finds for months.
 *
 * Both renderings draw on the same variables and the same reading, so the two
 * channels cannot report different numbers for one event.
 */
export default function TeamsWording({
  subject, body, onChange, onCommit, variables, emailSubject, emailBody,
}: {
  subject: string;
  body: string;
  onChange: (next: { subject: string; body: string }) => void;
  /**
   * Called when an edit is finished, not while it is being typed.
   *
   * The panels that own this save whenever a field changes, and without the
   * split that would be one request per keystroke: the field then re-renders
   * under its own save and types badly. Omitted by the alarm dialog, which has
   * a Save button and needs no such thing.
   */
  onCommit?: (next: { subject: string; body: string }) => void;
  variables: Array<{ name: string; description?: string }> | undefined;
  /** Shown as the fallback, so "off" is a statement rather than a blank. */
  emailSubject: string;
  emailBody: string;
}) {
  const on = !!(subject || body);
  const tpl = useTemplateInsert(
    subject, v => onChange({ subject: v, body }),
    body, v => onChange({ subject, body: v }),
  );

  // Turning it on or off is a decision, not a keystroke, so it saves at once.
  const commit = (next: { subject: string; body: string }) => {
    onChange(next);
    onCommit?.(next);
  };

  const label = "block text-xs font-semibold text-gray-600 dark:text-slate-300 mb-1";
  const input = "field-line text-[13.5px]";

  return (
    <div className="mt-4 pt-4 border-t border-rule dark:border-rule">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox" checked={on} className="mt-0.5"
          onChange={e => commit(e.target.checked
            // Seeded from the email wording rather than from nothing: the
            // common edit is a shorter version of it, and an empty box invites
            // starting again.
            ? { subject: emailSubject, body: emailBody }
            : { subject: "", body: "" })}
        />
        <span>
          <span className="display block text-[1rem] text-ink dark:text-slate-200">
            Word it differently on Teams
          </span>
          <span className="block text-xs text-gray-500 dark:text-slate-400 mt-0.5">
            {on
              ? "Teams gets the wording below. Email keeps the wording above."
              : "Off, so Teams gets the same wording as the email."}
          </span>
        </span>
      </label>

      {on && (
        <div className="mt-3 space-y-3">
          <div>
            <label className={label}>Teams title</label>
            <input {...tpl.subjectProps} value={subject}
              onChange={e => onChange({ subject: e.target.value, body })}
              onBlur={() => onCommit?.({ subject, body })}
              className={input} />
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              The line the notification shows, so the first few words matter most.
            </p>
          </div>
          <div>
            <label className={label}>Teams message</label>
            <textarea {...tpl.bodyProps} value={body}
              onChange={e => onChange({ subject, body: e.target.value })}
              onBlur={() => onCommit?.({ subject, body })}
              rows={4} className={input + " font-mono text-xs"} />
          </div>
          <VariableChips variables={variables} target={tpl.target} onInsert={tpl.insert} />
        </div>
      )}
    </div>
  );
}
