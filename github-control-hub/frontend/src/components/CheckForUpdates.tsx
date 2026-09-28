import { useState } from "react";

/** What the desktop app's update check answered. Mirrors desktop/src/main.ts. */
type CheckResult =
  | { outcome: "up-to-date"; version: string }
  | { outcome: "downloading"; version: string }
  | { outcome: "unavailable"; reason: string; message: string }
  | { outcome: "failed"; message: string };

type State = { phase: "idle" } | { phase: "checking" } | { phase: "done"; result: CheckResult };

/**
 * "Check for updates", on demand.
 *
 * The app already checks on its own — once AWS is connected, then every half
 * hour — and this runs that same check, in the desktop app's main process,
 * rather than a second one: pressing it while the scheduled check is running
 * joins it. A download that starts puts up the same full-screen overlay the
 * automatic one does.
 *
 * What it adds is an answer. The automatic check says nothing when there is
 * nothing new, and nothing either when it *could not ask* — before AWS is
 * connected, or on an account with no GitHub App — so "am I on the latest?"
 * had no way to be answered. This says which of those it is.
 *
 * Not drawn in a browser, where there is no installed build to update.
 */
export default function CheckForUpdates({ variant }: {
  /**
   * A row in the account menu, a row in the narrow-screen section sheet
   * (which sets its rows larger and without side padding), or a text link on
   * the sign-in screen.
   */
  variant: "menu" | "sheet" | "link";
}) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const check = window.electronAPI?.checkForUpdates;
  if (!check) return null;

  const run = async () => {
    setState({ phase: "checking" });
    try {
      setState({ phase: "done", result: (await check()) as CheckResult });
    } catch (err) {
      setState({ phase: "done", result: { outcome: "failed", message: (err as Error)?.message ?? String(err) } });
    }
  };

  const busy = state.phase === "checking";
  const label = busy ? "Checking…" : "Check for updates";
  const note = state.phase !== "done" ? null
    : state.result.outcome === "up-to-date" ? { tone: "good", text: `Up to date — v${state.result.version} is the latest.` }
    : state.result.outcome === "downloading" ? { tone: "good", text: `v${state.result.version} is downloading; the app restarts to install it.` }
    : state.result.outcome === "unavailable" ? { tone: "info", text: state.result.message }
    : { tone: "bad", text: `Could not check: ${state.result.message}` };
  const toneClass = note?.tone === "good" ? "text-forest" : note?.tone === "bad" ? "text-crimson" : "text-ink-2";

  if (variant === "menu") {
    return (
      <div className="border-b border-rule">
        <button role="menuitem" onClick={run} disabled={busy}
          className="w-full px-5 py-3.5 flex items-baseline justify-between gap-4 text-left
                     hover:bg-ink/[0.05] transition-colors disabled:opacity-60">
          <span className="caps text-ink">{label}</span>
        </button>
        {note && <p role="status" className={`px-5 pb-3.5 -mt-1.5 text-[0.75rem] leading-snug ${toneClass}`}>{note.text}</p>}
      </div>
    );
  }

  if (variant === "sheet") {
    return (
      <div className="border-b border-rule">
        <button onClick={run} disabled={busy}
          className="w-full flex items-baseline justify-between gap-4 py-3.5 text-left disabled:opacity-60">
          <span className="display text-[1.125rem] text-ink">{label}</span>
        </button>
        {note && <p role="status" className={`pb-3.5 -mt-1.5 text-[0.8125rem] leading-snug ${toneClass}`}>{note.text}</p>}
      </div>
    );
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button onClick={run} disabled={busy} className="textlink caps disabled:opacity-60">{label}</button>
      {note && <span role="status" className={`text-[0.75rem] leading-snug max-w-[34ch] ${toneClass}`}>{note.text}</span>}
    </span>
  );
}
