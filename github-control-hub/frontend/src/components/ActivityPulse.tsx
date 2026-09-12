import { useMemo, useState } from "react";
import type { ActivityPulse as Pulse } from "../api/activity";
import { SURFACE, TYPE } from "../design";

/**
 * The shape of the feed, in whichever of two encodings answers the question.
 *
 * It was stacked areas only, and stacking answers *composition*, how a total
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

/**
 * Three streams, in three of the page's four printed inks.
 *
 * The chart used to be drawn in indigo, amber and emerald picked off a generic
 * palette, which is three saturated hues that meant nothing beyond "these are
 * different". These are the same inks the rows below the chart carry, so a band
 * in the graph and a rule down the side of a record are recognisably the same
 * thing. Written as variables so both editions get them right.
 */
const STREAM = {
  github: { label: "GitHub", line: "rgb(var(--indigo))", area: "rgb(var(--indigo) / 0.22)" },
  aws:    { label: "AWS",    line: "rgb(var(--ochre))",  area: "rgb(var(--ochre) / 0.22)" },
  app:    { label: "App",    line: "rgb(var(--forest))", area: "rgb(var(--forest) / 0.22)" },
} as const;
type Stream = keyof typeof STREAM;
const ALL_STREAMS = Object.keys(STREAM) as Stream[];

/**
 * The streams this account can actually produce.
 *
 * An account holding no GitHub credentials records no GitHub rows, and the
 * server already refuses to return them. Drawing the stream anyway put a
 * permanent "GitHub 0" beside the real numbers, which reads as an organization
 * that has stopped doing anything rather than as a deployment that was never
 * watching one.
 */
function streamsFor(awsOnly: boolean): Stream[] {
  return awsOnly ? ALL_STREAMS.filter(s => s !== "github") : ALL_STREAMS;
}
type Mode = "lines" | "bars";

export default function ActivityPulse({ pulse, hours, onHours, isLoading, awsOnly = false }: {
  pulse?: Pulse;
  hours: number;
  onHours: (h: number) => void;
  isLoading: boolean;
  /** This account holds no GitHub credentials, so it records no GitHub rows. */
  awsOnly?: boolean;
}) {
  const STREAMS = useMemo(() => streamsFor(awsOnly), [awsOnly]);
  const [hover, setHover] = useState<number | null>(null);
  /**
   * Whether the pointer is over the bar itself, not merely over its column.
   *
   * The hit targets are full-height columns, which is right for the crosshair
   * and the tooltip: you should be able to read a bucket without aiming at a
   * two-pixel bar. But the dimming was tied to the same signal, so putting the
   * pointer anywhere in the chart, high above every bar, faded all of them.
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
  const shown = useMemo<Stream[]>(() => STREAMS.filter(s => !muted.has(s)), [muted, STREAMS]);

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
    <section className="border-t-2 border-ink">
      <div className="flex items-end justify-between gap-5 flex-wrap pt-4">
        <div>
          <div className="caps mb-2">Whole organization · not affected by the filters below</div>
          <div className="flex items-baseline gap-3">
            <span className="figure text-[2.75rem] text-ink">
              {isLoading ? " " : (pulse?.total ?? 0).toLocaleString()}
              {/* At least this many. The sentence underneath says why. */}
              {pulse && !pulse.exhausted && <span className="text-ink-3">+</span>}
            </span>
            <span className="caps">
              {pulse?.total === 1 ? "event" : "events"} in {label(hours)}
            </span>
          </div>
          {pulse && !pulse.exhausted && (
            <p className="standfirst text-[0.75rem] text-ochre mt-2 max-w-[52ch]">
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

      <div className="relative mt-6">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
          className="w-full h-[160px] overflow-visible" role="img"
          aria-label={`Activity over ${label(hours)}: ${pulse?.total ?? 0} events`}>
          {[0, 0.25, 0.5, 0.75].map(f => (
            <line key={f} x1="0" x2={W} y1={H * f} y2={H * f}
              className="stroke-rule" strokeWidth="1"
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
                          bg-ink px-3.5 py-2.5 text-[0.7188rem] text-reverse whitespace-nowrap">
            <div className="caps !text-reverse mb-2">{when(at.start, pulse!.bucketHours)}</div>
            <div className="grid gap-1">
              {shown.map(s => (
                <div key={s} className="flex items-center justify-between gap-5">
                  <span className="flex items-center gap-1.5 opacity-80">
                    <span className="w-2 h-2" style={{ background: STREAM[s].line }} />
                    {STREAM[s].label}
                  </span>
                  <span className="figure text-[0.875rem]">{at[s]}</span>
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
                className={`flex-1 min-w-0 text-[0.625rem] font-medium tabular-nums transition-colors
                  ${last ? "text-right" : "text-center"}
                  ${hover === i ? "text-ink" : "text-ink-3"}`}>
                {hover === i || show
                  ? (last && hover !== i ? "now" : axisTick(b.start, pulse?.bucketHours ?? 24))
                  : ""}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-6 py-4 mt-2 border-t border-rule flex-wrap">
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
              className={`flex items-baseline gap-2.5 transition-opacity ${
                off ? "opacity-35 hover:opacity-70" : ""}`}>
              <span className="w-2.5 h-2.5 shrink-0 translate-y-[1px]" style={{ background: STREAM[s].line }} />
              <span className="caps text-ink">{STREAM[s].label}</span>
              <span className="figure text-[0.875rem] text-ink-2">
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
    <div className="inline-flex items-stretch border-b border-rule-strong">
      {options.map(([v, icon, text], i) => (
        <button key={v} onClick={() => onChange(v)} aria-pressed={value === v}
          className={`caps px-3 py-1.5 -mb-px flex items-center gap-1.5 border-b-2 transition-colors
            ${i > 0 ? "border-l border-l-rule" : ""}
            ${value === v ? "text-ink border-b-ink" : "border-b-transparent hover:text-ink"}`}>
          {icon && <i className={`ph-bold ${icon} text-[0.75rem]`} aria-hidden="true" />}
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
