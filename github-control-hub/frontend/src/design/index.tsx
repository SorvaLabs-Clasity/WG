import { useState, useEffect, useRef } from "react";
import Navbar from "../components/Navbar";
import { INTENT, TYPE, SURFACE, RULE, EASE, enter, type Intent } from "./tokens";

export * from "./tokens";

/**
 * Shared UI primitives — The Broadsheet.
 *
 * Every page is set from these so the app reads as one printed object. The
 * vocabulary is a newspaper's: a masthead, headlines, standfirsts, small-cap
 * column heads, hairline-ruled records, datelines of middot-separated facts,
 * and figures set in the display serif. There is no card, no pill, no badge
 * and no raised button, because a page does not have those.
 *
 * Adding a screen means composing these. If something here does not fit, the
 * answer is a new rule or a new column head, not a new box.
 */

// ── page shell ────────────────────────────────────────────────────────

/**
 * Root wrapper. The masthead is `fixed` and two-tier — title rule on top,
 * section line under it — so pages must reserve its height. Doing it here
 * means no page has to remember, which is how two of them ended up sliding
 * underneath the old navbar.
 */
export function Page({ user, width = "wide", children }: {
  user?: { login?: string; avatarUrl?: string } | null;
  width?: "wide" | "narrow";
  children: React.ReactNode;
}) {
  return (
    <div className={`min-h-screen pt-[5.75rem] ${SURFACE.page}`}>
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className={`${width === "wide" ? "max-w-[1380px]" : "max-w-[62rem]"} mx-auto px-5 sm:px-8 pb-24 pt-7`}>
        {children}
      </main>
    </div>
  );
}

/**
 * The headline block that opens every screen.
 *
 * Serif headline, italic standfirst under it, actions on the same baseline at
 * the right, and a heavy rule closing the whole thing off — the masthead of the
 * story rather than a title bar.
 */
export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <header className="mb-7">
      <div className="flex items-end justify-between gap-6 flex-wrap pb-3">
        <div className="min-w-0">
          <h1 className={`${TYPE.title} text-ink`}>{title}</h1>
          {subtitle && <p className={`${TYPE.standfirst} mt-2 max-w-[58ch]`}>{subtitle}</p>}
        </div>
        {actions && <div className="flex items-end gap-5 shrink-0 flex-wrap">{actions}</div>}
      </div>
      <div className="border-t-2 border-ink" />
    </header>
  );
}

/**
 * A section within a page: small-cap column head over a heavy rule, with an
 * optional note and controls sharing the head's baseline.
 */
export function Section({ title, caption, actions, children, className = "" }: {
  title: string; caption?: React.ReactNode; actions?: React.ReactNode;
  children: React.ReactNode; className?: string;
}) {
  return (
    <section className={`mt-9 first:mt-0 ${className}`}>
      <div className="flex items-baseline justify-between gap-5 flex-wrap pb-2">
        <h2 className="caps text-ink">{title}</h2>
        {actions && <div className="flex items-baseline gap-4 flex-wrap">{actions}</div>}
      </div>
      <div className="border-t-2 border-ink" />
      {caption && <p className={`${TYPE.standfirst} text-[13.5px] mt-3 max-w-[70ch]`}>{caption}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A hairline, or the heavy rule that opens a section. */
export function Rule({ heavy = false, className = "" }: { heavy?: boolean; className?: string }) {
  return <div className={`${heavy ? RULE.heavy : RULE.hair} ${className}`} />;
}

/** Facts separated by middots, newspaper style. */
export function Dateline({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`dateline ${className}`}>{children}</div>;
}

/**
 * Re-fetches a screen's data on demand.
 *
 * Queries here have long stale times and window-focus refetching is off, so a
 * screen can sit on data that changed elsewhere with no way to say "look
 * again". Set as a text link, because refreshing is not the thing any screen is
 * for. The word is held past the response: an instant that looks identical to
 * nothing happening does not read as success.
 */
export function RefreshButton({ onRefresh, label = "Refresh", busy }: {
  onRefresh: () => Promise<unknown> | void;
  label?: string;
  busy?: boolean;
}) {
  const [spinning, setSpinning] = useState(false);
  const active = spinning || !!busy;

  const run = async () => {
    if (active) return;
    setSpinning(true);
    try { await onRefresh(); } finally { setTimeout(() => setSpinning(false), 500); }
  };

  return (
    <button onClick={run} disabled={active} title={label}
      className="textlink caps !text-[0.6875rem] disabled:no-underline">
      {active ? "Refreshing…" : label}
    </button>
  );
}

// ── the signature surface ─────────────────────────────────────────────

/** Counts up to `value` so a number's arrival is visible. Never loops. */
export function useCountUp(value: number, ms = 650) {
  const [n, setN] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = performance.now();
    const a = from.current, b = value;
    if (a === b) return;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min((t - start) / ms, 1);
      setN(Math.round(a + (b - a) * (1 - Math.pow(1 - p, 4))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = b;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return n;
}

/**
 * The ledger strip: a screen's standing at a glance.
 *
 * The app's signature element, and the one place a page states its own
 * posture. It is a ruled strip, not a coloured slab: a heavy rule in the
 * state's ink across the top, then the figures set in the display serif and
 * divided by column rules, the way a results table is set. State is carried by
 * that one rule and by the ink on the leading figure — enough to read before
 * any word on the page, and quiet enough to sit above a screen of records
 * without shouting over them.
 *
 * One per screen, at the top, or it stops meaning anything.
 */
export function StatusSlab({ intent, eyebrow, metrics, aside, footer }: {
  intent: Intent;
  eyebrow: string;
  metrics: { value: number; label: string; emphasis?: boolean }[];
  aside?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section className="mb-8" style={{ animation: `rise 0.5s ${EASE} both` }}>
      <div className={`h-[3px] w-full ${INTENT[intent].mark} transition-colors duration-700`} />
      <div className="pt-4 flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <p className={`caps ${INTENT[intent].text} mb-4`}>{eyebrow}</p>
          <div className="flex items-end flex-wrap">
            {metrics.map((m, i) => (
              <SlabMetric key={m.label} {...m} intent={intent} first={i === 0} />
            ))}
          </div>
        </div>
        {aside && <div className="flex flex-col items-end gap-4 shrink-0">{aside}</div>}
      </div>
      {footer && (
        <div className={`${RULE.hair} mt-5 pt-3 ${TYPE.sub} text-ink-2 max-w-[92ch]`}>{footer}</div>
      )}
    </section>
  );
}

function SlabMetric({ value, label, emphasis, intent, first }: {
  value: number; label: string; emphasis?: boolean; intent: Intent; first: boolean;
}) {
  const n = useCountUp(value);
  return (
    <div className={`${first ? "pr-8 sm:pr-11" : "px-8 sm:px-11 border-l border-rule"} py-1`}>
      <p className={`${emphasis || first ? TYPE.metric : "display figure text-[2.25rem]"} ${
        emphasis || first ? INTENT[intent].figure : "text-ink-2"}`}>
        {n}
      </p>
      <p className="caps mt-2.5">{label}</p>
    </div>
  );
}

/** The large percentage that sits at the right of a ledger strip. */
export function SlabPercent({ value, label }: { value: number; label: string }) {
  const n = useCountUp(value);
  return (
    <div className="text-right">
      <p className={`${TYPE.display} text-ink`}>
        {n}<span className="display text-[0.38em] align-top ml-0.5">%</span>
      </p>
      <p className="caps mt-2.5">{label}</p>
    </div>
  );
}

/** A figure and its column head, for a row of readings. */
export function Stat({ value, label, intent = "neutral", note }: {
  value: React.ReactNode; label: string; intent?: Intent; note?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <p className={`${TYPE.metricSm} ${INTENT[intent].figure}`}>{value}</p>
      <p className="caps mt-2">{label}</p>
      {note && <p className={`${TYPE.sub} text-ink-3 mt-1`}>{note}</p>}
    </div>
  );
}

// ── controls ──────────────────────────────────────────────────────────

/**
 * The app's buttons.
 *
 * `ghost` is the default idiom of the whole application — a text link, because
 * a printed page does not have raised rectangles on it. `primary` is a stamp:
 * an inked block with reversed-out small capitals, and it is deliberately the
 * only filled control in the vocabulary so that it keeps meaning "this is the
 * action this screen is for".
 */
export function Button({ variant = "secondary", onClick, disabled, children, className = "", type }: {
  variant?: "primary" | "secondary" | "onDark" | "ghost" | "caution";
  /**
   * Typed with the event it actually receives, even though almost nobody uses
   * it. This forwards straight to the DOM, so React calls it with a click
   * event. Declared `() => void` it was a lie the compiler believed: a handler
   * taking an optional parameter is assignable to a zero-parameter type, so
   * `onClick={handleThing}` for `handleThing(id?: string)` compiled clean and
   * then received a synthetic event as `id` at runtime.
   */
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; children: React.ReactNode;
  className?: string; type?: "button" | "submit";
}) {
  const styles: Record<string, string> = {
    primary: "stamp",
    secondary: "stamp stamp-hollow",
    /** On an inked ground: the stamp, reversed. */
    onDark: "stamp bg-paper text-ink border-paper hover:bg-transparent hover:text-paper",
    ghost: "textlink",
    /**
     * For an action that is safe but expensive and slow. Not crimson: nothing
     * here is destructive, and dressing it as destructive would be its own lie.
     * Ochre says "this one has a cost" and stops it reading identically to the
     * refresh link beside it.
     */
    caution: "stamp stamp-hollow !border-ochre-edge !text-ochre hover:!bg-ochre hover:!text-reverse",
  };
  return (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}
      className={`${styles[variant]} disabled:pointer-events-none ${className}`}>
      {children}
    </button>
  );
}

/**
 * A choice between readings of the same screen.
 *
 * Set as a line of small-cap links divided by hairlines, the way a newspaper
 * sets its section strip. The chosen one is inked and underlined; there is no
 * container, no track and no sliding thumb.
 */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <div className="inline-flex items-stretch border-b border-rule-strong">
      {options.map(([v, label], i) => (
        <button key={v} onClick={() => onChange(v)} aria-pressed={value === v}
          className={`caps px-3.5 py-2 -mb-px transition-colors ${i > 0 ? "border-l border-rule" : ""} ${
            value === v
              ? "text-ink border-b-2 border-ink"
              : "hover:text-ink border-b-2 border-transparent"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder }: {
  value: string; onChange: (v: string) => void; placeholder: string;
}) {
  return (
    <label className="relative flex-1 min-w-[15rem] max-w-sm flex items-baseline gap-2.5 border-b border-rule-strong focus-within:border-ink transition-colors">
      <i className="ph-bold ph-magnifying-glass text-ink-3 text-sm translate-y-0.5" aria-hidden="true"></i>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="field-line text-[13.5px] w-full" />
      {value && (
        <button onClick={() => onChange("")} aria-label="Clear search"
          className="caps text-ink-3 hover:text-ink shrink-0 pr-0.5">Clear</button>
      )}
    </label>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────

/** A ruled box: the sidebar treatment, for a reading that sits beside a story. */
export function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className={SURFACE.sheet} style={{ animation: `rise 0.35s ${EASE} both` }}>{children}</div>
  );
}

/**
 * The head of a ruled box.
 *
 * A heavy rule in the state's ink across the top, then the title on the page's
 * own stock. The previous design reversed a whole band out in the state colour,
 * which spent the loudest element on a screen restating a thing the figures
 * below it already said.
 */
export function SheetHeader({ intent = "neutral", title, subtitle, aside }: {
  intent?: Intent; title: string; subtitle?: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <div className="border-b border-rule">
      <div className={`h-[3px] w-full ${INTENT[intent].mark}`} />
      <div className="px-6 py-5 flex items-start justify-between gap-6 flex-wrap">
        <div className="min-w-0">
          <h2 className={`${TYPE.heading} text-ink text-[1.25rem]`}>{title}</h2>
          {subtitle && <p className={`${TYPE.standfirst} text-[13.5px] mt-1.5`}>{subtitle}</p>}
        </div>
        {aside && <div className="shrink-0 text-right">{aside}</div>}
      </div>
    </div>
  );
}

export function Block({ title, children, action }: {
  title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="px-6 py-5 border-b border-rule last:border-0">
      <div className="flex items-baseline justify-between gap-4 mb-3.5 pb-1.5 border-b border-rule">
        <h4 className="caps">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

/**
 * The app's standard record: one item in a list of them.
 *
 * A ruled box carrying a marginal bar in the state's ink down its left edge —
 * the printed equivalent of a change bar in a margin. Nothing lifts on hover,
 * because paper does not lift; the whole record takes a wash of ink instead.
 */
export function RailCard({ intent, index = 0, onClick, children }: {
  intent: Intent; index?: number; onClick?: () => void; children: React.ReactNode;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} style={enter(index)}
      className={`group relative w-full text-left block border border-rule bg-paper ${
        onClick ? "transition-colors duration-150 hover:bg-ink/[0.035]" : ""}`}>
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${INTENT[intent].mark}`} aria-hidden="true" />
      <div className="relative pl-6 pr-5 py-4">{children}</div>
    </Tag>
  );
}

/**
 * A count, set to be the first thing the eye lands on.
 *
 * Display serif, tabular, with its column head beneath in small capitals. The
 * previous design set these at body weight, so the number a screen exists to
 * report carried no more emphasis than the word describing it.
 */
export function Figure({ intent, value, label }: { intent: Intent; value: number | string; label: string }) {
  return (
    <div className="text-right shrink-0">
      <p className={`${TYPE.metricSm} ${INTENT[intent].figure}`}>{value}</p>
      <p className="caps caps-tight mt-1.5">{label}</p>
    </div>
  );
}

/** A recessed record, for findings listed inside a larger one. */
export function InsetRow({ intent, index = 0, children }: {
  intent: Intent; index?: number; children: React.ReactNode;
}) {
  return (
    <li style={enter(index, 16, 240)} className="relative bg-paper-2 border border-rule">
      <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${INTENT[intent].mark}`} aria-hidden="true" />
      <div className="relative pl-4 pr-3.5 py-2.5">{children}</div>
    </li>
  );
}

/** A note set into running text: washed stock behind a marginal rule. */
export function Note({ intent, children }: { intent: Intent; children: React.ReactNode }) {
  const t = INTENT[intent];
  return (
    <div className={`mb-5 pl-4 pr-4 py-3 border-l-2 ${t.soft} ${t.text} ${TYPE.body}`}
      style={{ borderLeftColor: "currentColor" }}>
      {children}
    </div>
  );
}

/** A tag. A boxed monospace fragment, never a lozenge. */
export function Chip({ intent = "neutral", children }: { intent?: Intent; children: React.ReactNode }) {
  const t = INTENT[intent];
  return (
    <span className={`inline-block font-mono text-[11.5px] leading-none px-1.5 py-1 border ${t.border} ${t.soft} ${t.text}`}>
      {children}
    </span>
  );
}

/** A stamp, at label size. Reserved for a state that must not be missed. */
export function Pill({ intent = "info", children }: { intent?: Intent; children: React.ReactNode }) {
  return (
    <span className={`inline-block caps caps-tight leading-none px-1.5 py-1 ${INTENT[intent].loud}`}>
      {children}
    </span>
  );
}

export function Back({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="textlink caps mb-4 inline-flex items-center gap-1.5">
      <span aria-hidden="true">←</span>{children}
    </button>
  );
}

/**
 * A sheet that slides in over the page, for a task that needs room.
 *
 * This exists because the alternative kept happening: every new feature became
 * another band stacked down the page, until the thing somebody opened the tab
 * for was four scrolls below controls they were not using. A task with its own
 * beginning and end — bulk-editing three hundred repositories being the case
 * it was built for — belongs on its own surface rather than pushing the page it
 * was launched from.
 *
 * Closes on Escape and on the scrim, because a surface that covers the page
 * must be dismissible without hunting for the control that does it. The page
 * behind it is frozen while it is open, so a scroll gesture over the scrim does
 * not silently move the content underneath.
 */
export function Drawer({ open, onClose, title, subtitle, children, footer }: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    // Restored rather than cleared: another drawer, or the page itself, may
    // have set it, and clearing would silently undo theirs.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer-scrim absolute inset-0 bg-ink/45 animate-[fadeIn_150ms_ease-out]"
        onClick={onClose} aria-hidden="true" />

      <div className="drawer-panel relative w-full max-w-3xl h-full flex flex-col bg-paper
                      border-l-2 border-ink animate-[slideIn_240ms_cubic-bezier(0.22,1,0.36,1)]">
        <header className="shrink-0 px-7 pt-6 pb-4 border-b-2 border-ink flex items-start justify-between gap-5">
          <div className="min-w-0">
            <h2 className={`${TYPE.heading} text-[1.375rem] text-ink`}>{title}</h2>
            {subtitle && (
              <p className={`${TYPE.standfirst} text-[13.5px] mt-1.5 max-w-[70ch]`}>{subtitle}</p>
            )}
          </div>
          <button onClick={onClose} aria-label="Close" className="textlink caps shrink-0 pt-1.5">
            Close
          </button>
        </header>

        {/* The only scrolling region, so the head and the actions stay put while
            a list of three hundred repositories moves under them. */}
        <div className="flex-1 overflow-y-auto px-7 py-6">{children}</div>

        {footer && (
          <div className="shrink-0 px-7 py-4 border-t-2 border-ink bg-paper-2">{footer}</div>
        )}
      </div>
    </div>
  );
}

/**
 * The shell both dialogs sit in.
 *
 * One implementation, because two would be two places for the scrim, the
 * Escape handling and the scroll lock to drift, and a dialog that traps the
 * page's scroll differently from the one beside it is the kind of difference
 * nobody notices until it is a bug.
 *
 * `dismissible` is false while work is running: closing then would hide a run
 * that is still going, and the next thing somebody does is press the button
 * again.
 */
function ModalShell({ open, onClose, title, intent, dismissible = true, width = "max-w-md", children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  intent: Intent;
  dismissible?: boolean;
  width?: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && dismissible) onClose(); };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4"
      role="dialog" aria-modal="true" aria-label={title}>
      <div className="drawer-scrim absolute inset-0 bg-ink/45 animate-[fadeIn_150ms_ease-out]"
        onClick={dismissible ? onClose : undefined} aria-hidden="true" />

      <div className={`relative w-full ${width} bg-paper border border-ink
                       animate-[rise_200ms_cubic-bezier(0.22,1,0.36,1)]`}>
        {/* The state's ink along the top edge rather than a tinted icon block:
            it says which kind of thing this is without spending a quarter of
            the dialog saying it. */}
        <span className={`block h-[3px] w-full ${INTENT[intent].mark}`} aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/**
 * A confirmation before something is done on somebody else's behalf.
 *
 * Not `window.confirm`. Two reasons, and the second is the one that bites: the
 * native dialog cannot say *what* is about to happen in more than a line, and
 * Electron's dialog handling is its own implementation rather than Chromium's,
 * which is how the bulk-close button came to be silently dead for a release
 * (`window.prompt` is not implemented there at all).
 *
 * The body is where the honesty lives. Every action this guards is a request to
 * a bot that acts later, not a change that has happened by the time the dialog
 * closes, and a dialog that implies otherwise is worse than none.
 */
export function ConfirmDialog({
  open, onClose, onConfirm, title, body, confirmLabel, intent = "info", busy,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  intent?: Intent;
  busy?: boolean;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) confirmRef.current?.focus(); }, [open]);

  const loud = intent === "danger" ? "stamp stamp-crimson" : "stamp";
  return (
    <ModalShell open={open} onClose={onClose} title={title} intent={intent} dismissible={!busy}>
      <div className="px-7 pt-6 pb-5">
        <h2 className={`${TYPE.heading} text-[1.375rem] text-ink`}>{title}</h2>
        <div className={`${TYPE.sub} text-ink-2 mt-3 leading-relaxed`}>{body}</div>
      </div>

      <div className="px-7 py-4 flex justify-end items-center gap-5 border-t border-rule bg-paper-2">
        <button className="textlink caps" onClick={onClose} disabled={busy}>Cancel</button>
        <button ref={confirmRef} onClick={onConfirm} disabled={busy} className={loud}>
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

/** One repository's outcome, as it lands. */
export interface ProgressLine {
  repo: string;
  ok: boolean;
  /** What happened, where that is more than "it worked". */
  note?: string;
}

/**
 * A long run, while it is running.
 *
 * These act on a repository at a time, paced so GitHub does not refuse the
 * burst, so sixty repositories is a minute or more. What was there before was a
 * button reading "Working…" and nothing else: no count, no idea which
 * repository, no way to tell a slow run from a stuck one, and every result
 * withheld until the last one finished.
 *
 * The measure is **real**, not a guess. It advances as each batch actually comes
 * back, and the lines are set as they land, so a run that stalls on repository
 * nineteen says so instead of looking identical to one that is nearly done.
 * Nothing here animates on a timer.
 */
export function ProgressDialog({
  open, onClose, title, done, total, lines, running, footer, intent = "info", cancel,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  done: number;
  total: number;
  lines: ProgressLine[];
  running: boolean;
  /** The closing summary, once there is one. */
  footer?: React.ReactNode;
  intent?: Intent;
  /**
   * How to stop, and what stopping means.
   *
   * The label is the caller's, because the two cases are genuinely different
   * and must not be dressed alike. Where the action has a true inverse the
   * caller offers to undo; where it does not, the honest offer is to stop, and
   * `note` says what stays done.
   */
  cancel?: { label: string; note?: string; run: () => void; pending?: boolean };
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const failed = lines.filter(l => !l.ok).length;

  return (
    <ModalShell open={open} onClose={onClose} title={title}
      intent={failed > 0 && !running ? "warn" : intent}
      dismissible={!running} width="max-w-lg">
      <div className="px-7 pt-6 pb-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className={`${TYPE.heading} text-[1.375rem] text-ink`}>{title}</h2>
          <span className="figure text-[1.5rem] text-ink tabular-nums">
            {done}<span className="text-ink-3"> / {total}</span>
          </span>
        </div>

        {/* The measure, set as a rule that inks in rather than a filling pill. */}
        <div className="mt-4 h-[3px] w-full bg-rule">
          <div role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={total}
            style={{ width: `${pct}%` }}
            className={`h-full ${INTENT[intent].mark} transition-[width] duration-300 ease-out`} />
        </div>

        {lines.length > 0 && (
          <ul className="mt-5 max-h-64 overflow-y-auto border-t border-rule">
            {lines.map(l => (
              <li key={l.repo} className="flex items-baseline gap-3 py-2 border-b border-rule">
                <span className={`w-1.5 h-1.5 shrink-0 translate-y-[-1px] ${INTENT[l.ok ? "good" : "danger"].mark}`}
                  aria-hidden="true" />
                <span className="font-mono text-[12.5px] text-ink truncate">{l.repo}</span>
                {l.note && (
                  <span className={`ml-auto text-[11.5px] truncate max-w-[55%] text-right ${
                    l.ok ? "text-ink-3" : INTENT.danger.text}`} title={l.note}>
                    {l.note}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="px-7 py-4 flex items-center justify-between gap-4 border-t border-rule bg-paper-2">
        <span className={`${TYPE.sub} text-ink-3 min-w-0`}>
          {running ? (cancel?.note ?? "Paced so GitHub does not refuse the burst.") : footer}
        </span>
        <div className="flex items-center gap-4 shrink-0">
          {running && cancel && (
            <button className="textlink caps" onClick={cancel.run} disabled={cancel.pending}>
              {cancel.pending ? "Stopping…" : cancel.label}
            </button>
          )}
          <button className={running ? "textlink caps" : "stamp"} onClick={onClose} disabled={running}>
            {running ? "Working…" : "Done"}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

/** Nothing to report, said in the page's own voice. */
export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="border-t-2 border-ink py-16 text-center">
      <p className={`${TYPE.heading} text-[1.375rem] text-ink`}>{title}</p>
      {body && <p className={`${TYPE.standfirst} text-[14px] mt-3 max-w-[46ch] mx-auto`}>{body}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

/**
 * A read that failed, said plainly, never as an empty result.
 *
 * The two render identically otherwise, and the empty one is *reassuring*:
 * "Nothing outstanding", "No alarms yet", "No open pull requests". Somebody
 * whose token had expired, or whose laptop had slept through the credentials
 * behind a tab going stale, was told in a calm voice that there was nothing to
 * see. On a security or compliance screen that is the worst available answer:
 * it under-reports, and it looks deliberate.
 *
 * `what` names the thing that could not be read, because "Something went wrong"
 * tells a person nothing they can act on.
 */
export function LoadFailed({ what, error, onRetry }: {
  what: string; error?: unknown; onRetry?: () => void;
}) {
  const reason = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (
    <Empty
      title={`Could not load ${what}`}
      body={`${reason ? reason.replace(/\.?$/, ". ") : ""}This is a failure to read, not a sign that there is nothing there.`}
      action={onRetry ? <Button variant="primary" onClick={() => onRetry()}>Try again</Button> : undefined}
    />
  );
}

/**
 * The grab strip between two columns.
 *
 * Sits in the header cell, pinned to its right edge, and is deliberately wider
 * than it looks: a 1px line is honest about where the boundary is and horrible
 * to hit, so the hit area is 9px and only the middle of it is ever painted.
 *
 * `touch-none` matters on a trackpad and a touchscreen; without it the browser
 * claims the gesture for scrolling and the drag never starts.
 */
export function ColumnResizeHandle({ active, onPointerDown, onPointerMove, onPointerUp, onDoubleClick, label }: {
  active?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onDoubleClick?: () => void;
  label: string;
}) {
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      title={`Drag to resize ${label} · double-click to reset`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
      // The header cell is a sort button; a drag must never read as a click on it.
      onClick={(e) => e.stopPropagation()}
      className={`absolute top-0 right-0 h-full w-[9px] translate-x-1/2 z-20 cursor-col-resize
        touch-none select-none flex justify-center group/resize
        ${active ? "" : "opacity-0 hover:opacity-100 focus-within:opacity-100"} transition-opacity`}
    >
      <span className={`w-px h-full transition-colors ${
        active ? "bg-ink" : "bg-rule-strong group-hover/resize:bg-ink"}`} />
    </span>
  );
}

/**
 * Waiting, set as type.
 *
 * A spinning ring is a widget from another design language. This is the word,
 * in the italic serif the rest of the page uses for an aside, over a rule that
 * inks across while the read is outstanding.
 */
export function Spinner({ label = "Setting the page" }: { label?: string }) {
  return (
    <div className="py-16 flex flex-col items-center gap-3" role="status" aria-live="polite">
      <div className="w-40 h-px bg-rule overflow-hidden">
        <div className="h-full w-1/3 bg-ink" style={{ animation: "ruleRun 1.15s ease-in-out infinite" }} />
      </div>
      <p className="standfirst text-[13.5px]">{label}…</p>
    </div>
  );
}

// ── table controls ────────────────────────────────────────────────────

/**
 * A sortable column head.
 *
 * The mark only appears on the sorted column. Showing a neutral arrow on every
 * head reads as "these are all sorted" and makes the real one hard to find.
 */
export function SortHeader({ label, columnKey, sortKey, sortDir, onSort, align = "left" }: {
  label: string;
  columnKey: string;
  sortKey: string | null;
  sortDir: "asc" | "desc";
  onSort: (key: string) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === columnKey;
  return (
    <button
      type="button"
      onClick={() => onSort(columnKey)}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      className={`group inline-flex items-baseline gap-1.5 caps transition-colors
        ${align === "right" ? "flex-row-reverse" : ""}
        ${active ? "text-ink" : "hover:text-ink"}`}
    >
      {label}
      <span aria-hidden="true" className={`text-[8px] transition-opacity ${
        active ? "opacity-100" : "opacity-0 group-hover:opacity-40"}`}>
        {active && sortDir === "desc" ? "▼" : "▲"}
      </span>
    </button>
  );
}

/**
 * Page navigation, and the count of what is being shown.
 *
 * Renders nothing when there is one page and no search: a pager under six rows
 * is furniture. When a search is active it stays, because "3 of 357" is the
 * answer to "did my search work".
 */
export function Pager({ page, totalPages, onPage, matchCount, totalCount, filtered, noun = "results" }: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
  matchCount: number;
  totalCount: number;
  filtered: boolean;
  noun?: string;
}) {
  if (totalPages <= 1 && !filtered) return null;
  return (
    <div className="flex items-baseline justify-between gap-5 pt-4 mt-1 border-t border-rule">
      <span className="caps">
        {filtered ? `${matchCount} of ${totalCount} ${noun}` : `${totalCount} ${noun}`}
      </span>
      {totalPages > 1 && (
        <div className="flex items-baseline gap-5">
          <button className="textlink caps" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            ← Previous
          </button>
          <span className="caps text-ink tabular-nums">Page {page} of {totalPages}</span>
          <button className="textlink caps" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
