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
    <div className="grid gap-8">
      {/* ── the numbers, with the first one leading ───────────────────
          Four equal boxes said all four mattered equally, which is how a
          dashboard ends up with nothing to look at first. The total leads and
          carries the trend; the rest are supporting facts at supporting size. */}
      {/* ── the numbers, with the first one leading ───────────────────
          Four equal boxes said all four mattered equally, which is how a
          dashboard ends up with nothing to look at first. The total leads and
          carries the trend; the rest are supporting facts at supporting size,
          divided by column rules the way a results table is set. */}
      <div className="mb-2">
        {/* The rule takes the trend's ink, so the direction is readable before
            the number is. */}
        <span aria-hidden="true" className={`block h-[3px] w-full ${
          delta === null ? "bg-rule-strong" : delta > 0 ? "bg-indigo" : "bg-forest"}`} />

        <div className="grid gap-0 sm:grid-cols-[1.4fr_1fr_1fr_1fr] columned pt-5">
          <div className="pr-8">
            <p className="caps">Events in {windowLabel}</p>
            <p className="figure text-[clamp(3rem,6vw,4.25rem)] mt-3 text-ink">
              {total.toLocaleString()}
              {pulse && !pulse.exhausted && <span className="text-ink-4">+</span>}
            </p>
            <div className="dateline mt-3">
              {delta !== null && (
                <span className={delta > 0 ? "text-indigo" : delta < 0 ? "text-forest" : ""}>
                  {delta > 0 ? "+" : ""}{delta}%
                </span>
              )}
              <span>
                {delta === null
                  ? (prev === null
                      ? "no earlier window to compare against"
                      : "nothing was recorded before this window")
                  : `against ${prev!.toLocaleString()} in the ${windowLabel} before`}
              </span>
            </div>
          </div>

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
        <div className="border-t border-rule mt-6" />
      </div>

      {/* ── the days of the window ───────────────────────────────────── */}
      <section className="border-t-2 border-ink">
        {/* A rule under the heading rather than a tinted bar behind it.
            The strip was chrome doing the work a line does: it made the card
            look like a window with a title bar, which is a heavier idea than
            "here is a heading and here is the thing". */}
        <div className="pt-4">
          <div className="flex items-baseline justify-between gap-4 flex-wrap">
            <h3 className="caps text-ink">Day by day</h3>
            <span className="caps">{pulse?.timeZone ?? "UTC"}</span>
          </div>
          <p className="standfirst text-[0.7812rem] mt-1.5">Every day of the window.</p>
        </div>
        <div className="pt-5 pb-6">
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
      <section className="border-t-2 border-ink">
        <div className="pt-4">
          <h3 className="caps text-ink">Most common events</h3>
          <p className="standfirst text-[0.7812rem] mt-1.5">
            What this organization spends its time doing.
          </p>
        </div>
        <div className="pt-5 pb-6">
        {(pulse?.topActions.length ?? 0) === 0 ? (
          <p className="text-[0.7812rem] text-slate-400 dark:text-slate-500">Nothing recorded in this window.</p>
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
                <span className="relative w-5 text-[0.6875rem] font-bold tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                  {i + 1}
                </span>
                <span className="relative text-[0.8125rem] font-semibold text-slate-800 dark:text-slate-100 truncate flex-1">
                  {actionLabel(a.action)}
                </span>
                <span className="relative text-[0.8125rem] font-bold tabular-nums text-slate-600 dark:text-slate-300 shrink-0">
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
    <div className="px-0 sm:px-8 py-4 sm:py-0 min-w-0">
      <p className="caps flex items-baseline gap-2">
        <i className={`ph-bold ${icon} text-[0.75rem] text-ink-3`} aria-hidden="true" />
        {label}
      </p>
      <p className="figure text-[2rem] text-ink mt-3">{value}</p>
      <p className="standfirst text-[0.7188rem] truncate mt-2">{foot}</p>
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
      <div className="flex items-end gap-[3px] h-28 border-b border-rule">
        {values.map((v, i) => (
          <button key={i} type="button"
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            aria-label={`${titleFor(i)}: ${v} ${v === 1 ? "event" : "events"}`}
            className="group relative flex-1 h-full flex items-end focus:outline-none">
            <div className={`w-full transition-colors
              ${v > 0 ? (hover === i ? "bg-ink" : "bg-ink/55") : "bg-rule"}`}
              style={{ height: v > 0 ? `${Math.max(6, (v / peak) * 100)}%` : "3px" }} />
          </button>
        ))}
      </div>

      <div className="flex gap-[3px] mt-1.5">
        {values.map((_, i) => (
          <span key={i} className={`flex-1 text-[0.5938rem] text-center tabular-nums transition-colors
            ${hover === i ? "text-ink" : "text-ink-3"}`}>
            {i % tickEvery === 0 || hover === i ? labelFor(i) : ""}
          </span>
        ))}
      </div>

      {/* Named on hover, because a tick can hold a day number and not a day.
          Pinned to the middle rather than following the pointer: a tooltip that
          moves is one you chase. */}
      {hover !== null && (
        <div className="absolute -top-2 left-1/2 -translate-x-1/2 pointer-events-none z-10
                        bg-ink px-3 py-1.5 text-[0.7188rem] text-reverse whitespace-nowrap">
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
