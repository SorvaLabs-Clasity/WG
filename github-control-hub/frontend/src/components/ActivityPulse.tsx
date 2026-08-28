import { useMemo, useState } from "react";
import type { ActivityPulse as Pulse } from "../api/activity";
import { SURFACE, TYPE } from "../design";

/**
 * The shape of the feed, in whichever of two encodings answers the question.
 *
 * It was stacked areas only, and stacking answers *composition* — how a total
 * is made up. Read as *comparison* it says things that are not true: with
 * GitHub at 132 and AWS at 2 on the same day, the AWS band begins at 132 and
 * its top edge sits at 134, so AWS looks as tall as GitHub. App on top of both
 * then looks tallest of all on 13 events. Every one of those readings is what
 * the picture showed, and none of them is what the data says.
 *
 * So there are two modes, and they are honest about being different questions:
 *
 *   Compare  every stream drawn from zero, overlapping, translucent. A height
 *            is a value.
 *   Compose  every bucket one bar, split into coloured parts. A height is a
 *            total and the parts are the mix.
 *
 * **Not filtered by the feed's own filters.** It is the backdrop the filtered
 * table sits in front of, and one that narrowed with the table would be the
 * table drawn twice.
 */

const STREAM = {
  github: { label: "GitHub", line: "#6366f1", area: "rgba(99,102,241,0.28)" },
  aws:    { label: "AWS",    line: "#f59e0b", area: "rgba(245,158,11,0.28)" },
  app:    { label: "App",    line: "#10b981", area: "rgba(16,185,129,0.28)" },
} as const;
type Stream = keyof typeof STREAM;
const STREAMS = Object.keys(STREAM) as Stream[];
type Mode = "lines" | "bars";

export default function ActivityPulse({ pulse, hours, onHours, isLoading }: {
  pulse?: Pulse;
  hours: number;
  onHours: (h: number) => void;
  isLoading: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  /**
   * Whether the pointer is over the bar itself, not merely over its column.
   *
   * The hit targets are full-height columns, which is right for the crosshair
   * and the tooltip: you should be able to read a bucket without aiming at a
   * two-pixel bar. But the dimming was tied to the same signal, so putting the
   * pointer anywhere in the chart — high above every bar — faded all of them.
   * Dimming is a comparison between one bar and the rest, so it should only
   * happen once a bar is actually the thing being pointed at.
   */
  const [onBar, setOnBar] = useState(false);
  const [muted, setMuted] = useState<Set<Stream>>(new Set());
  const [mode, setMode] = useState<Mode>(() => {
    try { return localStorage.getItem("activity:pulse-mode") === "bars" ? "bars" : "lines"; }
    catch { return "lines"; }
  });
  const setModePersistent = (m: Mode) => {
    setMode(m);
    try { localStorage.setItem("activity:pulse-mode", m); } catch { /* the view still changes */ }
  };

  const buckets = pulse?.buckets ?? [];
  const shown = useMemo<Stream[]>(() => STREAMS.filter(s => !muted.has(s)), [muted]);

  /**
   * Two scales, because the two modes measure different things.
   *
   * Compare is scaled to the tallest single value across **all** streams, muted
   * or not, so hiding one never re-scales the others. A line that grows because
   * you hid something either lied before or lies now.
   *
   * Compose is scaled to the tallest total of what is shown, because a stacked
   * bar *is* the total of its parts and hiding a part genuinely shortens it.
   */
  const peak = useMemo(() => {
    if (mode === "lines") return Math.max(1, ...buckets.flatMap(b => STREAMS.map(s => b[s])));
    return Math.max(1, ...buckets.map(b => shown.reduce((n, s) => n + b[s], 0)));
  }, [buckets, shown, mode]);

  const W = 1000, H = 160;
  const step = buckets.length > 1 ? W / (buckets.length - 1) : W;
  const y = (v: number) => H - (v / peak) * H;

  /** One area per stream, each from the baseline. Overlapping, never stacked. */
  const areas = useMemo(() => shown.map(stream => {
    const pts = buckets
      .map((b, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(b[stream]).toFixed(1)}`)
      .join("");
    return {
      stream, line: pts,
      fill: `${pts}L${((buckets.length - 1) * step).toFixed(1)},${H}L0,${H}Z`,
    };
  }), [buckets, shown, peak, step]);

  const at = hover === null ? null : buckets[hover];
  const barW = buckets.length ? Math.max(2, (W / buckets.length) * 0.6) : 0;

  return (
    <section className={`${SURFACE.card} overflow-hidden`}>
      <div className="flex items-end justify-between gap-4 flex-wrap px-6 pt-5">
        <div>
          <div className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-1.5`}>
            Whole organization · not affected by the filters below
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="text-[38px] font-black tabular-nums leading-none tracking-[-0.03em] text-slate-900 dark:text-white">
              {isLoading ? "—" : (pulse?.total ?? 0).toLocaleString()}
              {/* At least this many. The sentence underneath says why. */}
              {pulse && !pulse.exhausted && <span className="text-slate-400 dark:text-slate-500">+</span>}
            </span>
            <span className={`${TYPE.sub} text-slate-500 dark:text-slate-400`}>
              {pulse?.total === 1 ? "event" : "events"} in {label(hours)}
            </span>
          </div>
          {pulse && !pulse.exhausted && (
            <p className="text-[11.5px] text-amber-700 dark:text-amber-300 mt-1.5 max-w-[52ch]">
              Counted the newest {pulse.examined.toLocaleString()} rows, back to{" "}
              {pulse.oldest ? new Date(pulse.oldest).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "the limit"}.
              There is more behind that.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Switch value={mode} onChange={setModePersistent} options={[
            ["lines", "ph-chart-line", "Compare"],
            ["bars", "ph-chart-bar", "Compose"],
          ] as const} />
          <Switch value={String(hours)} onChange={(v: string) => onHours(Number(v))} options={[
            ["24", null, "24h"], ["168", null, "7d"], ["720", null, "30d"],
          ] as const} />
        </div>
      </div>

      <div className="relative mt-5 px-6">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
          className="w-full h-[160px] overflow-visible" role="img"
          aria-label={`Activity over ${label(hours)}: ${pulse?.total ?? 0} events`}>
          {[0, 0.25, 0.5, 0.75].map(f => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f}
              className="stroke-slate-200/70 dark:stroke-white/[0.07]" strokeWidth="1"
              vectorEffect="non-scaling-stroke" />
          ))}

          {mode === "lines" ? (
            areas.map(({ stream, line, fill }) => (
              <g key={stream}>
                {/* Translucent, so where two streams cover the same ground you
                    can see both. That is the whole reason not to stack them. */}
                <path d={fill} fill={STREAM[stream].area} />
                <path d={line} fill="none" stroke={STREAM[stream].line} strokeWidth="2"
                  vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            ))
          ) : (
            buckets.map((b, i) => {
              let acc = 0;
              const x = buckets.length > 1 ? i * step - barW / 2 : W / 2 - barW / 2;
              return (
                <g key={i} opacity={!onBar || hover === null || hover === i ? 1 : 0.4}>
                  {shown.map(s => {
                    const v = b[s];
                    if (!v) return null;
                    const h = (v / peak) * H;
                    const yTop = H - acc - h;
                    acc += h;
                    return <rect key={s} x={Math.max(0, Math.min(W - barW, x))} y={yTop}
                      width={barW} height={h} fill={STREAM[s].line} />;
                  })}
                </g>
              );
            })
          )}

          {hover !== null && mode === "lines" && (
            <line x1={hover * step} x2={hover * step} y1="0" y2={H}
              className="stroke-slate-400 dark:stroke-slate-500" strokeWidth="1"
              strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          )}
        </svg>

        <div className="absolute inset-x-6 top-0 h-[160px] flex"
          onPointerLeave={() => { setHover(null); setOnBar(false); }}>
          {buckets.map((b, i) => (
            <div key={i} className="flex-1"
              onPointerEnter={() => setHover(i)}
              onPointerMove={e => {
                // Where the pointer sits against this bucket's own bar. The
                // column is 160px tall whatever the bar is, so the comparison
                // has to be made in the same units the bar was drawn in.
                const box = e.currentTarget.getBoundingClientRect();
                const yPx = e.clientY - box.top;
                const stackTotal = shown.reduce((n, s) => n + b[s], 0);
                const barTopPx = H - (stackTotal / peak) * H;
                setOnBar(stackTotal > 0 && yPx >= barTopPx);
              }} />
          ))}
        </div>

        {at && (
          <div className="absolute -top-3 left-1/2 -translate-x-1/2 z-10 pointer-events-none
                          rounded-xl bg-slate-900 dark:bg-slate-100 px-3.5 py-2.5 shadow-xl
                          text-[11.5px] text-white dark:text-slate-900 whitespace-nowrap">
            <div className="font-bold mb-1.5">{when(at.start, pulse!.bucketHours)}</div>
            <div className="grid gap-1">
              {shown.map(s => (
                <div key={s} className="flex items-center justify-between gap-5">
                  <span className="flex items-center gap-1.5 opacity-80">
                    <span className="w-2 h-2 rounded-sm" style={{ background: STREAM[s].line }} />
                    {STREAM[s].label}
                  </span>
                  <span className="tabular-nums font-bold">{at[s]}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── the axis ────────────────────────────────────────────────────
            It said only where the window started and "now", which on a
            thirty-day chart leaves twenty-eight unlabelled columns and a spike
            you cannot date without hovering it. Ticks are laid on the same
            flex track as the hover targets, so a label sits under the column it
            belongs to rather than near it. */}
        <div className="flex mt-2">
          {buckets.map((b, i) => {
            const show = i % tickStride(buckets.length) === 0 || i === buckets.length - 1;
            const last = i === buckets.length - 1;
            return (
              <span key={i}
                className={`flex-1 min-w-0 text-[10px] font-medium tabular-nums transition-colors
                  ${last ? "text-right" : "text-center"}
                  ${hover === i ? "text-slate-700 dark:text-slate-200 font-bold"
                                : "text-slate-400 dark:text-slate-500"}`}>
                {hover === i || show
                  ? (last && hover !== i ? "now" : axisTick(b.start, pulse?.bucketHours ?? 24))
                  : ""}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-6 py-4 mt-1 flex-wrap">
        {STREAMS.map(s => {
          const off = muted.has(s);
          return (
            <button key={s} aria-pressed={!off}
              title={off ? `Show ${STREAM[s].label}` : `Hide ${STREAM[s].label}`}
              onClick={() => setMuted(prev => {
                const next = new Set(prev);
                // Never all three: an empty chart is not a view of anything.
                if (next.has(s)) next.delete(s);
                else if (next.size < STREAMS.length - 1) next.add(s);
                return next;
              })}
              className={`flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl border transition-all
                ${off
                  ? "border-transparent opacity-40 hover:opacity-70"
                  : "border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/25"}`}>
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: STREAM[s].line }} />
              <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200">
                {STREAM[s].label}
              </span>
              <span className="text-[12.5px] tabular-nums text-slate-400 dark:text-slate-500">
                {(pulse?.byCategory?.[s] ?? 0).toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** A small segmented control, used for both the mode and the window. */
function Switch<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly (readonly [T, string | null, string])[];
}) {
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-xl bg-slate-100 dark:bg-white/[0.06]">
      {options.map(([v, icon, text]) => (
        <button key={v} onClick={() => onChange(v)} aria-pressed={value === v}
          className={`px-2.5 py-1.5 rounded-lg text-[12px] font-semibold flex items-center gap-1.5 transition-all
            ${value === v
              ? "bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm"
              : "text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200"}`}>
          {icon && <i className={`ph-bold ${icon} text-[13px]`} aria-hidden="true" />}
          {text}
        </button>
      ))}
    </div>
  );
}

const label = (h: number) => (h <= 24 ? "24 hours" : h <= 168 ? "7 days" : "30 days");

function when(iso: string, bucketHours: number): string {
  const d = new Date(iso);
  return bucketHours < 24
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/**
 * Label roughly six columns, however many there are.
 *
 * Every column labelled is a row of overlapping text; two labelled is a chart
 * you have to hover to date. Six is about what fits at this size.
 */
function tickStride(n: number): number {
  return Math.max(1, Math.round(n / 6));
}

/** Short enough for an axis: a date, or a time when the buckets are hours. */
function axisTick(iso: string, bucketHours: number): string {
  const d = new Date(iso);
  return bucketHours < 24
    ? d.toLocaleTimeString(undefined, { hour: "numeric" }).replace(/\s/g, "")
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
