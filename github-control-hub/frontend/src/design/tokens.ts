/**
 * Design tokens.
 *
 * The app was styled as a GitHub clone, which is deliberately quiet and is why
 * every page read as flat. See /.impeccable.md — the agreed direction is
 * saturated colour, depth and motion, with colour only ever carrying meaning.
 *
 * Everything is a Tailwind class string rather than a CSS variable so the
 * existing utility-first pages can adopt it a piece at a time.
 *
 * Dark mode is specified explicitly rather than leaning on Tailwind's slate
 * ramp. slate-900 cards on a slate-950 page differ by about 4% luminance,
 * which reads as one flat sheet — the surfaces below step far enough apart to
 * be legible, and status colours are brightened so they survive a dark ground.
 */

/** Semantic state. Nothing else in the app should be this saturated. */
export type Intent = "danger" | "warn" | "good" | "info" | "neutral";

interface IntentStyle {
  /** Solid fill for hero surfaces — white text sits on these. */
  solid: string;
  /** Tinted surface for inline notes and chips. */
  soft: string;
  /** Text on a light background, brightened for dark. */
  text: string;
  /** Small solid marker: rails, dots. */
  mark: string;
  border: string;
  /** Loud fill for badges that must not be missed. */
  loud: string;
  /** Large numbers. Needs more punch than body text at the same hue. */
  figure: string;
}

export const INTENT: Record<Intent, IntentStyle> = {
  danger: {
    solid: "bg-[#9f1239] dark:bg-[#8d1d2c]",
    soft: "bg-rose-50 dark:bg-rose-500/[0.14]",
    text: "text-rose-700 dark:text-rose-300",
    mark: "bg-rose-500 dark:bg-rose-400",
    border: "border-rose-200 dark:border-rose-500/30",
    loud: "bg-rose-600 text-white",
    figure: "text-rose-600 dark:text-rose-350 dark:[color:#ff8095]",
  },
  warn: {
    solid: "bg-[#9a5b00] dark:bg-[#8a5a00]",
    soft: "bg-amber-50 dark:bg-amber-500/[0.14]",
    text: "text-amber-700 dark:text-amber-300",
    mark: "bg-amber-500 dark:bg-amber-400",
    border: "border-amber-200 dark:border-amber-500/30",
    loud: "bg-amber-500 text-white",
    figure: "text-amber-600 dark:[color:#ffc14d]",
  },
  good: {
    solid: "bg-[#0b6b3a] dark:bg-[#0b6b3a]",
    soft: "bg-emerald-50 dark:bg-emerald-500/[0.14]",
    text: "text-emerald-700 dark:text-emerald-300",
    mark: "bg-emerald-500 dark:bg-emerald-400",
    border: "border-emerald-200 dark:border-emerald-500/30",
    loud: "bg-emerald-600 text-white",
    figure: "text-emerald-600 dark:[color:#3ddc97]",
  },
  info: {
    solid: "bg-[#123a6b] dark:bg-[#123a6b]",
    soft: "bg-blue-50 dark:bg-blue-500/[0.14]",
    text: "text-blue-700 dark:text-blue-300",
    mark: "bg-blue-500 dark:bg-blue-400",
    border: "border-blue-200 dark:border-blue-500/30",
    loud: "bg-blue-600 text-white",
    figure: "text-blue-600 dark:[color:#6bb4ff]",
  },
  neutral: {
    solid: "bg-slate-700 dark:bg-[#1c2230]",
    soft: "bg-slate-50 dark:bg-white/[0.05]",
    text: "text-slate-600 dark:text-slate-300",
    mark: "bg-slate-300 dark:bg-slate-600",
    border: "border-slate-200 dark:border-white/10",
    loud: "bg-slate-500 text-white",
    figure: "text-slate-500 dark:text-slate-400",
  },
};

/**
 * Type scale. Deliberately wide gaps — the previous design sat everything
 * between 12px and 16px, which is why nothing had presence.
 */
export const TYPE = {
  display: "text-[64px] sm:text-[80px] font-black tabular-nums leading-[0.82] tracking-[-0.03em]",
  metric: "text-[56px] sm:text-[68px] font-black tabular-nums leading-[0.85] tracking-tighter",
  /** Count on a card. Large enough to be the first thing the eye lands on. */
  metricSm: "text-[38px] font-black tabular-nums leading-none tracking-tight",
  title: "text-2xl font-black tracking-tight",
  heading: "text-[17px] font-bold tracking-tight",
  body: "text-sm",
  sub: "text-[13.5px]",
  label: "text-[11px] uppercase tracking-[0.18em] font-bold",
  mono: "font-mono text-[13.5px]",
};

/**
 * Whose install this is. Set VITE_COMPANY_NAME at build time; the app is meant
 * to be handed to another company without editing components to do it.
 */
export const COMPANY_NAME: string =
  (import.meta.env.VITE_COMPANY_NAME as string | undefined) || "Control Hub";

export const SURFACE = {
  /** Page ground. Tinted toward blue rather than pure grey. */
  page: "bg-[#f6f7fa] dark:bg-[#0b0e14]",
  /** Raised surface. In dark this is LIGHTER than the page, not darker. */
  card: "bg-white dark:bg-[#151a23] rounded-2xl border border-slate-200/80 dark:border-white/[0.09] shadow-sm",
  cardHover: "hover:shadow-xl hover:-translate-y-0.5 hover:border-slate-300 dark:hover:border-white/20 transition-all duration-200",
  sheet: "bg-white dark:bg-[#151a23] rounded-2xl border border-slate-200 dark:border-white/[0.09] shadow-lg overflow-hidden",
  /** Recessed surface, for rows inside a card. */
  inset: "bg-slate-50 dark:bg-white/[0.04] border border-slate-200/70 dark:border-white/[0.07]",
  raised: "shadow-[0_18px_40px_-12px_rgba(15,23,42,0.35)] dark:shadow-[0_18px_50px_-12px_rgba(0,0,0,0.7)]",
  input: "w-full px-3.5 py-2.5 text-sm bg-white dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 rounded-xl text-slate-700 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:focus:ring-white/25",
  /** Navigation. Follows the theme rather than being permanently dark. */
  nav: "bg-white dark:bg-[#11141c] border-b border-slate-200 dark:border-white/[0.08]",
};

/** Motion confirms; it never loops. Curve is ease-out-quart throughout. */
export const EASE = "cubic-bezier(0.16,1,0.3,1)";

export function enter(index = 0, step = 45, cap = 400): React.CSSProperties {
  return { animation: `fadeInUp 0.45s ${EASE} ${Math.min(index * step, cap)}ms both` };
}
