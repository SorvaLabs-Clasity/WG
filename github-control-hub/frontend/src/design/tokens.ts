/**
 * Design tokens.
 *
 * The app was styled as a GitHub clone, which is deliberately quiet and is why
 * every page read as flat. See /.impeccable.md — the agreed direction is
 * saturated colour, depth and motion, with colour only ever carrying meaning.
 *
 * Everything here is a Tailwind class string rather than a CSS variable so the
 * existing utility-first pages can adopt it a piece at a time.
 */

/** Semantic state. Nothing else in the app should be this saturated. */
export type Intent = "danger" | "warn" | "good" | "info" | "neutral";

interface IntentStyle {
  /** Solid fill for hero surfaces — white text sits on these. */
  solid: string;
  /** Tinted surface for inline notes and chips. */
  soft: string;
  /** Text colour on a light background. */
  text: string;
  /** Small solid marker: rails, dots. */
  mark: string;
  border: string;
}

export const INTENT: Record<Intent, IntentStyle> = {
  // Deep, slightly desaturated so large fills read as serious rather than alarming.
  danger: {
    solid: "bg-[#8d1d2c]",
    soft: "bg-rose-50 dark:bg-rose-950/40",
    text: "text-rose-700 dark:text-rose-300",
    mark: "bg-rose-500",
    border: "border-rose-200 dark:border-rose-900",
  },
  warn: {
    solid: "bg-[#8a5a00]",
    soft: "bg-amber-50 dark:bg-amber-950/40",
    text: "text-amber-700 dark:text-amber-300",
    mark: "bg-amber-500",
    border: "border-amber-200 dark:border-amber-900",
  },
  good: {
    solid: "bg-[#0b6b3a]",
    soft: "bg-emerald-50 dark:bg-emerald-950/40",
    text: "text-emerald-700 dark:text-emerald-300",
    mark: "bg-emerald-500",
    border: "border-emerald-200 dark:border-emerald-900",
  },
  info: {
    solid: "bg-[#123a6b]",
    soft: "bg-blue-50 dark:bg-blue-950/40",
    text: "text-blue-700 dark:text-blue-300",
    mark: "bg-blue-500",
    border: "border-blue-200 dark:border-blue-900",
  },
  neutral: {
    solid: "bg-slate-800",
    soft: "bg-slate-50 dark:bg-slate-800",
    text: "text-slate-600 dark:text-slate-300",
    mark: "bg-slate-300 dark:bg-slate-600",
    border: "border-slate-200 dark:border-slate-700",
  },
};

/**
 * Type scale. Deliberately wide gaps — the previous design sat everything
 * between 12px and 16px, which is why nothing had presence.
 */
export const TYPE = {
  /** Oversized display number for a hero surface. */
  display: "text-[64px] sm:text-[80px] font-black tabular-nums leading-[0.82] tracking-[-0.03em]",
  /** Hero metric on a status surface. */
  metric: "text-[56px] sm:text-[68px] font-black tabular-nums leading-[0.85] tracking-tighter",
  metricSm: "text-[30px] font-black tabular-nums leading-none",
  /** Page title. */
  title: "text-2xl font-black tracking-tight",
  /** Card and panel headings. */
  heading: "text-[17px] font-bold tracking-tight",
  body: "text-sm",
  /** Supporting line under a heading. */
  sub: "text-[13.5px]",
  /** Section label above a group. */
  label: "text-[11px] uppercase tracking-[0.18em] font-bold",
  mono: "font-mono text-[13.5px]",
};

export const SURFACE = {
  /** Page background. Tinted toward the brand blue rather than pure grey. */
  page: "bg-[#f7f8fb] dark:bg-[#0a0c11]",
  /** Dark surface used for headers and the nav. */
  ink: "bg-[#11131a] dark:bg-[#11131a]",
  /** Standard raised surface. */
  card: "bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/70 dark:border-slate-700/70 shadow-sm",
  /** Interactive card — lifts on hover. */
  cardHover: "hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200",
  /** Panel that sits above the page. */
  sheet: "bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-lg overflow-hidden",
  /** Deep shadow for hero surfaces. */
  raised: "shadow-[0_18px_40px_-12px_rgba(15,23,42,0.35)]",
  input: "w-full px-3.5 py-2.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:focus:ring-white/20",
};

/** Motion confirms; it never loops. Curve is ease-out-quart throughout. */
export const EASE = "cubic-bezier(0.16,1,0.3,1)";

export function enter(index = 0, step = 45, cap = 400): React.CSSProperties {
  return { animation: `fadeInUp 0.45s ${EASE} ${Math.min(index * step, cap)}ms both` };
}
