import { useMemo, useState } from "react";
import type { ActivityPulse as Pulse } from "../api/activity";
import { SURFACE, TYPE } from "../design";
import { actionLabel } from "../lib/activityActions";

/**
 * Statistics: the organization's activity as a picture rather than a list.
 *
 * Everything here is unfiltered and organization-wide. That is the whole point
 * of a separate view, the Events tab is for finding one row, and this is for
 * seeing the shape all of them make, which are different jobs that were sharing
 * one screen and getting in each other's way.
 *
 * All of it comes from one walk of the feed, aggregated on the server, so a
 * page of six visuals costs one read rather than six.
 */

export default function ActivityStats({ pulse, hours, windowLabel }: {
  pulse?: Pulse;
  hours: number;
  windowLabel: string;
}) {
  const total = pulse?.total ?? 0;
  const prev = pulse?.previousTotal ?? null;

  /**
   * The change against the window before this one.
   *
   * Null rather than zero when there is no previous window to compare with.
   * "No change" and "nothing to compare against" are different answers and a
   * dash is the honest rendering of the second.
   */
  const delta = useMemo(() => {
    // A truncated count is a floor, and a percentage between two floors is not
    // a percentage of anything. `previousTotal` is already null in that case,
    // so this reads as "nothing to compare against" rather than as a trend.
    if (prev === null) return null;
    if (prev === 0) return total === 0 ? 0 : null;   // no baseline to be a share of
    return Math.round(((total - prev) / prev) * 100);
  }, [total, prev]);

  const busiestHour = useMemo(() => pickPeak(pulse?.byHour ?? []), [pulse]);
  const busiestDay = useMemo(
    () => pickPeak((pulse?.byDay ?? []).map(d => d.count)), [pulse]);

  return (
    <div className="grid gap-4">
      {/* ── the numbers, with the first one leading ───────────────────
          Four equal boxes said all four mattered equally, which is how a
          dashboard ends up with nothing to look at first. The total leads and
          carries the trend; the rest are supporting facts at supporting size. */}
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className={`${SURFACE.card} relative overflow-hidden px-6 py-5`}>
          {/* A wash behind the headline, tinted by which way the trend went.
              Colour doing a second job: you can read the direction before you
              have read the number. */}
          <div aria-hidden="true"
            className={`pointer-events-none absolute -right-16 -top-16 w-56 h-56 rounded-full blur-2xl opacity-[0.16]
              ${delta === null ? "bg-slate-400" : delta > 0 ? "bg-gh-blue" : "bg-emerald-500"}`} />

          <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
            Events in {windowLabel}
          </div>
          <div className="flex items-end gap-3 mt-2.5">
            <span className="text-[52px] font-semibold tabular-nums leading-[0.85] tracking-[-0.04em] text-slate-900 dark:text-ink">
              {total.toLocaleString()}
              {pulse && !pulse.exhausted && <span className="text-slate-300 dark:text-slate-600">+</span>}
            </span>
            {delta !== null && (
              <span className={`mb-1.5 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] font-bold tabular-nums
                ${delta > 0
                  ? "bg-gh-blue/10 dark:bg-blue-400/15 text-gh-blue dark:text-blue-300"
                  : delta < 0
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-slate-100 dark:bg-ink/[0.07] text-slate-500 dark:text-slate-400"}`}>
                <i className={`ph-bold ${delta > 0 ? "ph-trend-up" : delta < 0 ? "ph-trend-down" : "ph-minus"} text-[12px]`}
                   aria-hidden="true" />
                {delta > 0 ? "+" : ""}{delta}%
              </span>
            )}
          </div>
          <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-2.5">
            {delta === null
              ? (prev === null
                  ? "No earlier window was read, so there is nothing to compare against."
                  : "Nothing was recorded before this window.")
              : `against ${prev!.toLocaleString()} in the ${windowLabel} before`}
          </p>
        </div>

        {/* One panel divided by hairlines, not three cards floating apart.
            Three bordered boxes beside a fourth said these were four peers;
            they are three readings of the same thing and belong on one
            surface. The `gap-px` over a tinted background is how the
            leaderboards are already built, so this is the app's own idiom
            rather than a new one. */}
        <div className={`${SURFACE.card} overflow-hidden grid sm:grid-cols-3 lg:grid-cols-1
                         gap-px bg-slate-200/70 dark:bg-ink/[0.07]`}>
          <MiniStat icon="ph-clock" label="Busiest hour"
            value={busiestHour ? clockHour(busiestHour.i) : "\u2014"}
            foot={busiestHour ? `${busiestHour.v} events · ${pulse?.timeZone ?? "UTC"}` : "nothing recorded"} />
          <MiniStat icon="ph-calendar-blank" label="Busiest day"
            value={busiestDay ? dayShort(pulse?.byDay?.[busiestDay.i]?.date) : "\u2014"}
            foot={busiestDay ? `${busiestDay.v} events` : "nothing recorded"} />
          <MiniStat icon="ph-users-three" label="People involved"
            value={String(pulse?.topActors.length ?? 0)}
            foot={(pulse?.topActors.length ?? 0) >= 6 ? "six shown, there may be more" : "excluding automation"} />
        </div>
      </div>

      {/* ── the days of the window ───────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        {/* A rule under the heading rather than a tinted bar behind it.
            The strip was chrome doing the work a line does: it made the card
            look like a window with a title bar, which is a heavier idea than
            "here is a heading and here is the thing". */}
        <div className="px-6 pt-5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-ink">
              Day by day
            </h3>
            <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
              {pulse?.timeZone ?? "UTC"}
            </span>
          </div>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            Every day of the window.
          </p>
          <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3.5" />
        </div>
        <div className="px-6 pt-4 pb-5">
        {/* Each calendar day of the window, not each day of the week. Seven
            bars headed Mon to Sun cannot tell you which Tuesday, and "which
            one" is the question somebody looking at a spike is asking. */}
        <Bars
          values={(pulse?.byDay ?? []).map(d => d.count)}
          labelFor={i => dayTick(pulse?.byDay?.[i]?.date)}
          titleFor={i => dayFull(pulse?.byDay?.[i]?.date)}
          tickEvery={tickStride(pulse?.byDay?.length ?? 0)} />
        </div>
      </section>

      {/* ── what kinds of thing ──────────────────────────────────────── */}
      <section className={`${SURFACE.card} overflow-hidden`}>
        <div className="px-6 pt-5">
          <h3 className="text-[13px] font-bold tracking-tight text-slate-900 dark:text-ink">
            Most common events
          </h3>
          <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            What this organization spends its time doing.
          </p>
          <div className="h-px bg-slate-200/70 dark:bg-ink/[0.07] mt-3.5" />
        </div>
        <div className="px-6 pt-4 pb-5">
        {(pulse?.topActions.length ?? 0) === 0 ? (
          <p className="text-[12.5px] text-slate-400 dark:text-slate-500">Nothing recorded in this window.</p>
        ) : (
          <div className="grid gap-1">
            {pulse!.topActions.map((a, i) => (
              <div key={a.action}
                className="relative flex items-center gap-3 px-3 py-2 rounded-xl overflow-hidden">
                {/* The bar is the row's own background rather than a separate
                    element beside the text. A number sitting next to a bar is
                    two things to read; a number sitting *in* one is a length. */}
                <div className="absolute inset-y-0 left-0 rounded-xl transition-[width] duration-500"
                  style={{
                    width: `${Math.max(4, (a.count / pulse!.topActions[0].count) * 100)}%`,
                    background: streamTint(a.action),
                  }}
                  aria-hidden="true" />
                <span className="relative w-5 text-[11px] font-bold tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                  {i + 1}
                </span>
                <span className="relative text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate flex-1">
                  {actionLabel(a.action)}
                </span>
                <span className="relative text-[13px] font-bold tabular-nums text-slate-600 dark:text-slate-300 shrink-0">
                  {a.count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
        </div>
      </section>
    </div>
  );
}

/**
 * A supporting number: an icon, a label, a value, a line.
 *
 * Laid out sideways rather than stacked, so three of them read as a list of
 * facts about the headline beside them rather than as three more headlines.
 */
/**
 * One reading, as a cell on a shared surface.
 *
 * No border and no shadow of its own: the panel around it provides both, and a
 * card inside a card is two edges where one would do. The icon is a hairline
 * outline rather than a filled tile, so three of them in a column read as a
 * list rather than as three buttons.
 */
function MiniStat({ icon, label, value, foot }: {
  icon: string; label: string; value: string; foot: string;
}) {
  return (
    <div className="bg-white dark:bg-paper px-5 py-4 flex items-start gap-3.5">
      <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center
                       border border-slate-200 dark:border-ink/10 text-slate-400 dark:text-slate-500">
        <i className={`ph-bold ${icon} text-[14px]`} aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <div className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>{label}</div>
        <div className="text-[21px] font-semibold tabular-nums leading-none tracking-tight text-slate-900 dark:text-ink mt-1.5">
          {value}
        </div>
        <div className="text-[11px] text-slate-400 dark:text-slate-500 truncate mt-1">{foot}</div>
      </div>
    </div>
  );
}

/**
 * A row of bars, scaled to their own peak.
 *
 * Against the total every bar in a busy window is a sliver; against the peak
 * the shape is legible, which is the only thing a chart this small can carry.
 */
function Bars({ values, labelFor, titleFor, tickEvery }: {
  values: number[];
  /** Short text under the axis. */
  labelFor: (i: number) => string;
  /** The full name, shown on hover. An axis tick has no room for it. */
  titleFor: (i: number) => string;
  tickEvery: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...values);

  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <div className="flex items-end gap-[3px] h-28">
        {values.map((v, i) => (
          <button key={i} type="button"
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            aria-label={`${titleFor(i)}: ${v} ${v === 1 ? "event" : "events"}`}
            className="group relative flex-1 h-full flex items-end rounded-t-[3px]
                       focus:outline-none focus-visible:ring-2 focus-visible:ring-gh-blue/40">
            <div className={`w-full rounded-t-[3px] transition-colors
              ${v > 0
                ? (hover === i ? "bg-gh-blue dark:bg-blue-400" : "bg-gh-blue/60 dark:bg-blue-400/50")
                : "bg-slate-200 dark:bg-ink/[0.07]"}`}
              style={{ height: v > 0 ? `${Math.max(6, (v / peak) * 100)}%` : "3px" }} />
          </button>
        ))}
      </div>

      <div className="flex gap-[3px] mt-1.5">
        {values.map((_, i) => (
          <span key={i} className={`flex-1 text-[9.5px] text-center tabular-nums transition-colors
            ${hover === i ? "text-slate-700 dark:text-slate-200 font-semibold" : "text-slate-400 dark:text-slate-500"}`}>
            {i % tickEvery === 0 || hover === i ? labelFor(i) : ""}
          </span>
        ))}
      </div>

      {/* Named on hover, because a tick can hold a day number and not a day.
          Pinned to the middle rather than following the pointer: a tooltip that
          moves is one you chase. */}
      {hover !== null && (
        <div className="absolute -top-2 left-1/2 -translate-x-1/2 pointer-events-none z-10
                        rounded-lg bg-slate-900 dark:bg-paper-3 px-3 py-1.5 shadow-lg
                        text-[11.5px] font-semibold text-reverse dark:text-slate-900 whitespace-nowrap">
          {titleFor(hover)} · {values[hover]} {values[hover] === 1 ? "event" : "events"}
        </div>
      )}
    </div>
  );
}

/** The index of the largest value, or null when nothing happened at all. */
function pickPeak(values: number[]): { i: number; v: number } | null {
  let best = -1, at = -1;
  values.forEach((v, i) => { if (v > best) { best = v; at = i; } });
  return best > 0 ? { i: at, v: best } : null;
}

/**
 * A "YYYY-MM-DD" as a short label.
 *
 * Parsed as parts rather than handed to `new Date`, which reads a bare date
 * string as UTC midnight and can render the day before in a western zone.
 */
function dayShort(iso?: string): string {
  if (!iso) return "\u2014";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Day-of-month alone, for an axis where the month is already obvious. */
function dayTick(iso?: string): string {
  return iso ? String(Number(iso.slice(8, 10))) : "";
}

/** Label roughly seven days however long the window is, so ticks stay legible. */
function tickStride(days: number): number {
  return Math.max(1, Math.ceil(days / 8));
}

/** A full date for the hover, where a tick only has room for the day number. */
function dayFull(iso?: string): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
  });
}

/**
 * An hour on a clock rather than on a 24-hour dial.
 *
 * "14:00" is correct and is not how anybody says it. The zone is named beside
 * the number, so the only thing left to get right is the format.
 */
function clockHour(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

/**
 * A faint wash in the colour of the stream an action belongs to.
 *
 * The same three colours as the chart and the row rails, so a bar here and a
 * band up there are recognisably about the same thing. Faint, because it is a
 * length being read and not a hue.
 */
function streamTint(action: string): string {
  if (action.startsWith("aws.")) return "rgba(245,158,11,0.16)";
  if (action.startsWith("github.") || action.startsWith("repo.")
      || action.startsWith("branch.") || action.startsWith("security.")) {
    return "rgba(99,102,241,0.16)";
  }
  return "rgba(16,185,129,0.16)";
}
