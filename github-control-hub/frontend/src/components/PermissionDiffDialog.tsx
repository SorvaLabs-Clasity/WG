import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { TYPE, SURFACE, Button } from "../design";
import type { AccountDiff } from "./permissionDiff";

/**
 * What will change, read the way a diff is read.
 *
 * The summary under the Save button answers "is this roughly right". This
 * answers "what exactly am I about to do", which is the question somebody asks
 * before changing what a colleague can do in production — and the one a count
 * of gains and losses cannot answer.
 *
 * **Portalled to `document.body`.** Rendered in place, it sat inside a card
 * with a transform somewhere above it, and a transform makes that ancestor the
 * containing block for `position: fixed` — so `fixed inset-0` measured against
 * the card, and the dialog opened wherever the card happened to be, often off
 * screen. `AnalyticsPage` hit and documented the same thing; a portal escapes
 * the whole chain and keeps escaping it if a transform is added later.
 *
 * **Two panes, each scrolling on its own.** The list of changed accounts (or
 * people, on the preset page — forty-eight of them) used to sit above the diff
 * with no height cap, and pushed the diff down into a sliver. The list is now a
 * sidebar and the diff fills the rest; both are bounded by the dialog, which is
 * bounded by the screen. Every flex child that scrolls carries `min-h-0`,
 * without which a flex item refuses to shrink below its content and the whole
 * dialog grows off the bottom of the screen.
 */
export default function PermissionDiffDialog({
  title, subtitle, diffs, notes = [], onCancel, onConfirm, confirming,
}: {
  title: string;
  subtitle?: string;
  diffs: AccountDiff[];
  /**
   * Changes that are not permissions — a rename, a description, a note, a
   * preset being created empty. They count as changes: without them a rename
   * produced an empty diff, and an empty diff disables Save, so a preset could
   * not be renamed at all.
   */
  notes?: string[];
  onCancel: () => void;
  onConfirm: () => void;
  confirming?: boolean;
}) {
  const changed = useMemo(() => diffs.filter(d => !d.unchanged), [diffs]);
  const [at, setAt] = useState(0);
  const index = Math.min(at, Math.max(0, changed.length - 1));
  const current = changed[index];

  const totals = useMemo(() => ({
    gained: changed.reduce((n, d) => n + d.gained.length, 0),
    lost: changed.reduce((n, d) => n + d.lost.length, 0),
  }), [changed]);

  /**
   * The page behind does not scroll while this is open. Otherwise a wheel over
   * the backdrop scrolls the page, which is how somebody loses their place and
   * reads it as the dialog having moved.
   */
  //
  // Mount-only, and kept apart from the key handler below. Callers pass
  // `onCancel` as a fresh arrow each render; in one effect that re-ran on every
  // render, and the cleanup "restored" an overflow it had already set to
  // hidden — so the page stayed unscrollable after the dialog closed.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !confirming) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, confirming]);

  const multiple = changed.length > 1;
  const nothing = changed.length === 0 && notes.length === 0;

  return createPortal((
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-slate-900/40" onClick={() => !confirming && onCancel()} />

      <div className={`${SURFACE.sheet} relative w-full max-w-5xl h-[85vh] flex flex-col min-h-0`}>
        <div className="px-5 py-4 border-b border-rule shrink-0">
          <h2 className="display text-[1.25rem] text-ink">{title}</h2>
          {subtitle && <p className={`${TYPE.sub} text-ink-3 mt-0.5`}>{subtitle}</p>}
          <p className={`${TYPE.sub} text-ink-2 mt-2`}>
            {nothing
              ? "Nothing would change."
              : changed.length === 0
                ? "No permissions change."
                : <>
                  <span className="text-forest">+{totals.gained}</span>
                  {" "}
                  <span className="text-crimson">−{totals.lost}</span>
                  {" across "}
                  {changed.length} {changed.length === 1 ? "entry" : "entries"}
                </>}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row flex-1 min-h-0">
          {multiple && (
            <nav aria-label="Changed entries"
              className="sm:w-64 shrink-0 border-b sm:border-b-0 sm:border-r border-rule overflow-y-auto min-h-0 max-h-40 sm:max-h-none">
              {changed.map((d, i) => (
                <button key={d.accountId} onClick={() => setAt(i)}
                  aria-current={i === index ? "true" : undefined}
                  className={`w-full text-left px-4 py-2 border-b border-rule flex items-center justify-between gap-2 ${
                    i === index ? "bg-ink/[0.06] text-ink" : "text-ink-2 hover:bg-ink/[0.035]"}`}>
                  <span className={`${TYPE.sub} truncate min-w-0`}>{d.name}</span>
                  <span className="shrink-0 font-mono text-[0.75rem]">
                    <span className="text-forest">+{d.gained.length}</span>
                    <span className="ml-1 text-crimson">−{d.lost.length}</span>
                  </span>
                </button>
              ))}
            </nav>
          )}

          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto px-5 py-4">
            {notes.length > 0 && (
              <ul className={`${TYPE.sub} text-ink-2 mb-4 grid gap-1`}>
                {notes.map(n => <li key={n}>· {n}</li>)}
              </ul>
            )}
            {!current ? (
              <p className={`${TYPE.body} text-ink-3`}>
                {notes.length > 0
                  ? "Nobody's permissions change."
                  : "The permissions are the same as the ones already saved."}
              </p>
            ) : (
              <>
                <p className={`${TYPE.sub} text-ink-2 mb-3`}>
                  <span className="text-ink">{current.name}</span>
                  {multiple && <span className="text-ink-3"> — {index + 1} of {changed.length}</span>}
                </p>
                {/*
                  * One line per permission, `+` or `−`, in the tree's words with
                  * the file's key beside them. Lines are free to wrap: a long
                  * label truncated to fit is a label nobody can read.
                  */}
                <div className="font-mono text-[0.8125rem] leading-relaxed">
                  {current.gained.map(l => (
                    <div key={`+${l.key}`} className="flex gap-2 px-2 py-1 bg-forest-wash text-forest">
                      <span aria-hidden="true" className="shrink-0">+</span>
                      <span className="sr-only">Gains</span>
                      <span className="min-w-0 break-words">{l.label}<span className="opacity-60"> · {l.key}</span></span>
                    </div>
                  ))}
                  {current.lost.map(l => (
                    <div key={`-${l.key}`} className="flex gap-2 px-2 py-1 bg-crimson-wash text-crimson">
                      <span aria-hidden="true" className="shrink-0">−</span>
                      <span className="sr-only">Loses</span>
                      <span className="min-w-0 break-words">{l.label}<span className="opacity-60"> · {l.key}</span></span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="px-5 py-4 border-t border-rule flex items-center justify-between gap-3 flex-wrap shrink-0">
          <div className="flex items-center gap-2">
            {multiple && (
              <>
                <Button variant="ghost" disabled={index === 0} onClick={() => setAt(index - 1)}>
                  Previous
                </Button>
                <Button variant="ghost" disabled={index >= changed.length - 1}
                  onClick={() => setAt(index + 1)}>
                  Next
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" disabled={confirming} onClick={onCancel}>Cancel</Button>
            <Button variant="primary" disabled={confirming || nothing} onClick={onConfirm}>
              {confirming ? "Saving…" : "Save these changes"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  ), document.body);
}
