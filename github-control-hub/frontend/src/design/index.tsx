import { useState, useEffect, useRef } from "react";
import Navbar from "../components/Navbar";
import { INTENT, TYPE, SURFACE, EASE, enter, type Intent } from "./tokens";

export * from "./tokens";

/**
 * Shared UI primitives.
 *
 * Every page assembles from these so the app reads as one product. Adding a
 * page should mean composing these, not inventing another card style.
 */

// ── page shell ────────────────────────────────────────────────────────

/**
 * Root wrapper. The navbar is `fixed h-14`, so pages must reserve that space
 * themselves — two pages shipped without it and slid underneath. Doing it here
 * means no page has to remember.
 */
export function Page({ user, width = "wide", children }: {
  user?: { login?: string; avatarUrl?: string } | null;
  width?: "wide" | "narrow";
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen pt-16 bg-slate-50 dark:bg-slate-950">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className={`${width === "wide" ? "max-w-[1400px]" : "max-w-[1000px]"} mx-auto px-6 py-6`}>
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: React.ReactNode; actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
      <div>
        <h1 className={`${TYPE.title} text-slate-900 dark:text-white`}>{title}</h1>
        {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
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
 * Full-width status surface whose colour follows state.
 *
 * The app's signature element: posture should be readable before any text is.
 * One per page, at the top, or it stops meaning anything.
 */
export function StatusSlab({ intent, eyebrow, metrics, aside, footer }: {
  intent: Intent;
  eyebrow: string;
  metrics: { value: number; label: string; emphasis?: boolean }[];
  aside?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <section
      className={`relative overflow-hidden rounded-3xl px-8 py-8 sm:px-10 sm:py-9 mb-6 ${SURFACE.raised} ${INTENT[intent].solid} transition-colors duration-700`}
      style={{ animation: `fadeInUp 0.5s ${EASE} both` }}
    >
      {/* Angled wash and orb give depth without glassmorphism or gradient text. */}
      <div className="pointer-events-none absolute inset-0 opacity-[0.22]"
        style={{ background: "linear-gradient(115deg, rgba(255,255,255,0.5) 0%, rgba(255,255,255,0) 45%)" }} />
      <div className="pointer-events-none absolute -right-24 -top-24 w-72 h-72 rounded-full bg-white/10" />

      <div className="relative flex flex-wrap items-start justify-between gap-8">
        <div>
          <p className={`${TYPE.label} text-white/60 mb-3`}>{eyebrow}</p>
          <div className="flex items-end gap-10 sm:gap-14">
            {metrics.map(m => <SlabMetric key={m.label} {...m} />)}
          </div>
          {footer && <div className="text-sm text-white/70 mt-5">{footer}</div>}
        </div>
        {aside && <div className="flex flex-col items-end gap-4">{aside}</div>}
      </div>
    </section>
  );
}

function SlabMetric({ value, label, emphasis }: { value: number; label: string; emphasis?: boolean }) {
  const n = useCountUp(value);
  return (
    <div>
      <p className={`text-white ${emphasis ? TYPE.metric : "text-[34px] sm:text-[40px] font-black tabular-nums leading-[0.85] tracking-tighter text-white/75"}`}>
        {n}
      </p>
      <p className={`${TYPE.label} mt-2 ${emphasis ? "text-white/70" : "text-[10px] text-white/50"}`}>{label}</p>
    </div>
  );
}

/** Large percentage for the right of a slab. */
export function SlabPercent({ value, label }: { value: number; label: string }) {
  const n = useCountUp(value);
  return (
    <div className="text-right">
      <p className="text-[64px] sm:text-[76px] leading-[0.85] font-black text-white tabular-nums tracking-tighter">
        {n}<span className="text-3xl align-top">%</span>
      </p>
      <p className={`${TYPE.label} text-white/60 mt-2`}>{label}</p>
    </div>
  );
}

// ── controls ──────────────────────────────────────────────────────────

export function Button({ variant = "secondary", onClick, disabled, children, className = "", type }: {
  variant?: "primary" | "secondary" | "onDark" | "ghost";
  onClick?: () => void; disabled?: boolean; children: React.ReactNode;
  className?: string; type?: "button" | "submit";
}) {
  const styles = {
    primary: "bg-slate-900 dark:bg-white text-white dark:text-slate-900 shadow-sm hover:shadow-md hover:scale-[1.02] active:scale-[0.99]",
    secondary: "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 shadow-sm hover:shadow",
    onDark: "bg-white text-slate-900 shadow-lg hover:scale-[1.03] active:scale-[0.98]",
    ghost: "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white",
  }[variant];
  const pad = variant === "ghost" ? "px-2 py-1.5" : "px-4 py-2.5";
  return (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}
      className={`${pad} rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:pointer-events-none ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: [T, string][];
}) {
  return (
    <div className="flex p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)}
          className={`px-3.5 py-1.5 text-[13px] font-bold rounded-lg transition-all ${
            value === v ? "bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm"
                        : "text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"}`}>
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
    <div className="relative flex-1 min-w-[240px] max-w-sm">
      <i className="ph-bold ph-magnifying-glass absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"></i>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className={`${SURFACE.input} pl-10 shadow-sm`} />
    </div>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────

export function Sheet({ children }: { children: React.ReactNode }) {
  return (
    <div className={SURFACE.sheet} style={{ animation: `slideUp 0.35s ${EASE} both` }}>{children}</div>
  );
}

/** Coloured header for a Sheet, so context survives when a page swaps views. */
export function SheetHeader({ intent = "neutral", title, subtitle, aside }: {
  intent?: Intent; title: string; subtitle?: React.ReactNode; aside?: React.ReactNode;
}) {
  return (
    <div className={`px-7 py-6 ${INTENT[intent].solid} flex items-start justify-between gap-6 flex-wrap`}>
      <div className="min-w-0">
        <h2 className="text-xl font-black text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-sm text-white/70 mt-1.5">{subtitle}</p>}
      </div>
      {aside && <div className="shrink-0 text-right">{aside}</div>}
    </div>
  );
}

export function Block({ title, children, action }: {
  title: string; children: React.ReactNode; action?: React.ReactNode;
}) {
  return (
    <div className="px-7 py-6 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <div className="flex items-center justify-between mb-4">
        <h4 className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

/** Row card with a coloured status rail. The app's standard list item. */
export function RailCard({ intent, index = 0, onClick, children }: {
  intent: Intent; index?: number; onClick?: () => void; children: React.ReactNode;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} style={enter(index)}
      className={`group relative w-full text-left ${SURFACE.card} ${onClick ? SURFACE.cardHover : ""} overflow-hidden block`}>
      <span className={`absolute left-0 top-0 bottom-0 w-1.5 ${INTENT[intent].mark}`} />
      <div className="pl-7 pr-6 py-5">{children}</div>
    </Tag>
  );
}

export function Note({ intent, children }: { intent: Intent; children: React.ReactNode }) {
  const t = INTENT[intent];
  return (
    <div className={`mb-5 px-4 py-3 rounded-xl border text-sm shadow-sm ${t.soft} ${t.border} ${t.text}`}>
      {children}
    </div>
  );
}

export function Chip({ intent = "neutral", children }: { intent?: Intent; children: React.ReactNode }) {
  const t = INTENT[intent];
  return <span className={`text-[12px] font-mono font-medium px-2.5 py-1 rounded-lg ${t.soft} ${t.text}`}>{children}</span>;
}

export function Pill({ intent = "info", children }: { intent?: Intent; children: React.ReactNode }) {
  const solid = { danger: "bg-rose-600", warn: "bg-amber-600", good: "bg-emerald-600", info: "bg-blue-600", neutral: "bg-slate-500" }[intent];
  return <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full text-white ${solid}`}>{children}</span>;
}

export function Back({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-bold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors">
      <i className="ph-bold ph-arrow-left text-xs"></i>{children}
    </button>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className={`${SURFACE.card} py-20 text-center`}>
      <p className="text-xl font-bold text-slate-800 dark:text-slate-100">{title}</p>
      {body && <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-sm mx-auto">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="py-20 flex justify-center">
      <div className="animate-spin rounded-full h-7 w-7 border-2 border-slate-200 dark:border-slate-700 border-t-slate-900 dark:border-t-white"></div>
    </div>
  );
}
