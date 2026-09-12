import { SEVERITIES, type Severity, type WeekBucket } from "../lib/alertSituations";

/**
 * The small charts on the Security tab.
 *
 * No chart library. These are two shapes, a stacked column and a row of
 * bars, and both are a handful of divs. Pulling in a charting dependency to
 * draw them would cost more than it explains.
 *
 * **The severity ramp is one ramp, not four colours.** Critical and high stay
 * in the same rose family the rest of the app uses for danger, with critical
 * the darker of the two, so a bar means the same thing as a pill. Picking four
 * unrelated hues would read as four unrelated categories.
 */
export const SEVERITY_BAR: Record<Severity, string> = {
  critical: "bg-crimson",
  high: "bg-crimson/60",
  medium: "bg-ochre",
  low: "bg-rule-strong",
};

export const SEVERITY_DOT: Record<Severity, string> = {
  critical: "bg-crimson",
  high: "bg-crimson/60",
  medium: "bg-ochre",
  low: "bg-rule-strong",
};

/**
 * Twelve weeks of alerts, stacked by severity.
 *
 * Weeks with nothing in them are drawn as an empty track rather than skipped.
 * A chart built only from the weeks that have data draws a busy month and a
 * quiet one identically, and the gaps are the shape being looked for.
 */
export function ActivityChart({ buckets, selected, onSelect }: {
  buckets: WeekBucket[];
  /** `start` of the selected week, or null. */
  selected: number | null;
  onSelect: (start: number | null) => void;
}) {
  const peak = Math.max(1, ...buckets.map(b => b.total));

  return (
    <div>
      <div className="flex items-stretch gap-[3px] sm:gap-1.5 h-32">
        {buckets.map(b => {
          const isOn = selected === b.start;
          const dimmed = selected !== null && !isOn;
          return (
            <button
              key={b.start}
              type="button"
              onClick={() => onSelect(isOn ? null : b.start)}
              // The whole column is the target, not just the drawn bar: a week
              // with no alerts has nothing to aim at otherwise, and "show me
              // the quiet week" is a reasonable thing to click.
              className={`group relative flex-1 h-full flex flex-col justify-end rounded-md
                ${isOn ? "bg-slate-900/[0.06] dark:bg-ink/10" : "hover:bg-slate-900/[0.04] dark:hover:bg-ink/[0.06]"}
                ${dimmed ? "opacity-40" : ""} transition-all duration-200 focus:outline-none
                focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-ink/30`}
              aria-pressed={isOn}
              aria-label={`Week of ${b.label}: ${b.total} ${b.total === 1 ? "alert" : "alerts"}`}
            >
              <div className="flex flex-col justify-end w-full px-[2px] pb-[3px]"
                   style={{ height: `${Math.max(4, (b.total / peak) * 100)}%` }}>
                {b.total === 0 ? (
                  <div className="w-full h-[3px]  bg-slate-200 dark:bg-ink/10" />
                ) : (
                  SEVERITIES.map(s => b.bySeverity[s] > 0 && (
                    <div key={s}
                      className={`w-full ${SEVERITY_BAR[s]} first:rounded-t-[3px] last:rounded-b-[3px]`}
                      style={{ height: `${(b.bySeverity[s] / b.total) * 100}%`, minHeight: 3 }} />
                  ))
                )}
              </div>

              {/* Sits above everything and ignores the pointer, so moving
                  along the chart never lands on the tooltip instead of the
                  next column. */}
              <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-20
                              opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap
                              rounded-lg bg-slate-900 dark:bg-paper-3 px-2.5 py-1.5
                              text-[0.7188rem] font-semibold text-reverse dark:text-slate-900 shadow-lg">
                {b.label} · {b.total || "nothing"}
                {b.total > 0 && (
                  <span className="font-normal opacity-70">
                    {" "}({SEVERITIES.filter(s => b.bySeverity[s] > 0)
                      .map(s => `${b.bySeverity[s]} ${s}`).join(", ")})
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex justify-between mt-2 text-[0.6562rem] font-medium text-slate-400 dark:text-slate-500 tabular-nums">
        <span>{buckets[0]?.label}</span>
        <span>this week</span>
      </div>
    </div>
  );
}

/**
 * A tile's own history, so "0 this week" arrives with the context that makes
 * it either reassuring or alarming.
 */
export function Spark({ values, intent = "bg-slate-400 dark:bg-paper-4", label }: {
  values: number[];
  intent?: string;
  /** What these weeks are counting, for the reading of it below. */
  label?: string;
}) {
  const peak = Math.max(1, ...values);
  return (
    <div className="flex items-end gap-[2px] h-6"
      // Not decorative: the shape over twelve weeks is the reason the tile has
      // a chart at all, and the sentence beside it only says what happened
      // most recently. Read out as a list of weeks, oldest first.
      role="img"
      aria-label={weeksAloud(values, label)}>
      {values.map((v, i) => (
        <div key={i}
          className={`w-[3px]  ${v > 0 ? intent : "bg-slate-200 dark:bg-ink/10"}`}
          style={{ height: v > 0 ? `${Math.max(18, (v / peak) * 100)}%` : "3px" }} />
      ))}
    </div>
  );
}

/**
 * The sparkline as a sentence.
 *
 * Twelve numbers read aloud one by one is not usable, so this says the shape:
 * the total, the busiest week, and how recently anything happened. Weeks are
 * counted back from this one, because "week 4" means nothing without a
 * reference point and a date would be read out twelve times.
 */
export function weeksAloud(values: number[], label = "events"): string {
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return `No ${label} in the last ${values.length} weeks.`;

  const weeksAgo = (i: number) => {
    const back = values.length - 1 - i;
    return back === 0 ? "this week" : back === 1 ? "last week" : `${back} weeks ago`;
  };
  const busiest = values.indexOf(Math.max(...values));
  const lastAny = values.length - 1 - [...values].reverse().findIndex(v => v > 0);

  return `${total} ${label} over ${values.length} weeks. ` +
    `Busiest was ${weeksAgo(busiest)} with ${values[busiest]}. ` +
    `Most recent ${weeksAgo(lastAny)}.`;
}
