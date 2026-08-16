import { useRef, useState } from "react";

/**
 * Inserting a placeholder into an email template by clicking it.
 *
 * Typing `{{widget}}` by hand is how a `{{widget}]` got saved, and a template
 * only reports its mistakes by arriving in somebody's inbox looking wrong — by
 * which point the email has been sent. Clicking cannot mistype.
 *
 * Two details that are the whole point of doing it properly:
 *
 *   - it goes in at the caret, not at the end. A body is several lines and the
 *     placeholder is almost never wanted below all of them.
 *   - the caret ends up after what was inserted, so clicking twice puts the
 *     second one after the first rather than back at the end.
 *
 * Shared by all three template editors — the alarm dialog, the security panel
 * and the vulnerability panel — because three copies of caret arithmetic is
 * three chances to get it subtly different.
 */
export function useTemplateInsert(
  subject: string, setSubject: (v: string) => void,
  body: string, setBody: (v: string) => void,
) {
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // The body, not the subject, because that is the longer of the two and the
  // one somebody opens this to edit.
  const [target, setTarget] = useState<"subject" | "body">("body");

  function insert(name: string) {
    const token = `{{${name}}}`;
    const el = target === "subject" ? subjectRef.current : bodyRef.current;
    const set = target === "subject" ? setSubject : setBody;
    const text = target === "subject" ? subject : body;

    // No element yet means nothing has been focused; appending is the only
    // sensible position and is better than dropping the click.
    if (!el) return set(text + token);

    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? start;
    set(text.slice(0, start) + token + text.slice(end));

    // After React has re-rendered with the new value. Setting it synchronously
    // would be overwritten by the re-render and the caret would jump to the end.
    requestAnimationFrame(() => {
      el.focus();
      const at = start + token.length;
      el.setSelectionRange(at, at);
    });
  }

  return {
    subjectRef, bodyRef, target, insert,
    subjectProps: { ref: subjectRef, onFocus: () => setTarget("subject") },
    bodyProps: { ref: bodyRef, onFocus: () => setTarget("body") },
  };
}

export default function VariableChips({ variables, target, onInsert, children }: {
  variables: Array<{ name: string; description?: string }> | undefined;
  target: "subject" | "body";
  onInsert: (name: string) => void;
  /** Anything extra to say under the chips, such as which timezone applies. */
  children?: React.ReactNode;
}) {
  if (!variables) return null;
  return (
    <div>
      <p className="text-xs text-gray-500 dark:text-slate-400 mb-1.5">
        Click to insert into the{" "}
        <strong className="font-semibold">{target}</strong> at the cursor.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {variables.map(v => (
          <button key={v.name} type="button" title={v.description}
            onClick={() => onInsert(v.name)}
            className="px-2 py-1 rounded-md text-xs font-mono bg-black/5 dark:bg-white/10 text-gh-textBase dark:text-slate-200 hover:bg-gh-blue hover:text-white transition-colors">
            {`{{${v.name}}}`}
          </button>
        ))}
      </div>
      {children && (
        <p className="mt-2 text-xs text-gray-500 dark:text-slate-400">{children}</p>
      )}
    </div>
  );
}
