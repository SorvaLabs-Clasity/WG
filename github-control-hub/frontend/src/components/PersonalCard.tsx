import { useMemo } from "react";
import { useWidgetData, verdictFor, entityForConfig, nounFor, TONE } from "../pages/AnalyticsPage";
import { widgetColumns } from "../lib/widgetColumns";
import {
  filterableColumns, activeFilterCount, describeFilter, isActive, valueFor,
} from "../lib/widgetFilters";
import type { WidgetConfig } from "../api/widgets";

/**
 * A card on somebody's own board.
 *
 * Deliberately not the Overview card. That one is a status tile: it exists to
 * be scanned across a wall of others, so it leads with a share of the
 * organization, a colour for how bad that is, and a verdict rolled into a
 * page-level headline. None of that is what a personal board is for.
 *
 * This one leads with the count, at a size you can read across a grid, because
 * the first version led with the list and buried the number in a subtitle —
 * which made a card with four problems look exactly like a card with none. The
 * rows sit underneath as the evidence for it.
 *
 * It also says out loud when a filter is deciding that number, since a figure
 * that quietly disagrees with the same check on the Overview is the one thing
 * this feature could get badly wrong.
 *
 * The data path is shared with the Overview on purpose. Same hook, same rows,
 * same verdict function; only the presentation differs, so the two boards
 * cannot come to different conclusions about the same check.
 */
export default function PersonalCard({
  config, onOpen, onEdit, onRemove, onFilters, onAlarm, alarmCount = 0,
}: {
  config: WidgetConfig;
  onOpen: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onFilters: () => void;
  onAlarm: () => void;
  /** How many of this person's own alarms watch this card. */
  alarmCount?: number;
}) {
  const { items, allItems, isLoading, total, error, filtered, unfiltered } =
    useWidgetData(config, {});

  const entity = entityForConfig(config);
  const verdict = useMemo(
    () => verdictFor(items, total, config), [items, total, config]);

  // Chips name the column, so a filter reads the way the table does.
  const labels = useMemo(() => {
    const cols = widgetColumns({
      type: config.type,
      presetId: config.presetId,
      hasStatus: (allItems ?? []).some((i: any) => i.status),
      hasOwner: (allItems ?? []).some((i: any) => "owner" in i),
      hasVisibility: (allItems ?? []).some((i: any) => "visibility" in i),
      hasBypasses: (allItems ?? []).some((i: any) => typeof i.bypasses === "number"),
    });
    return new Map(filterableColumns(cols, allItems ?? []).map(c => [c.id, c.label]));
  }, [config, allItems]);

  const chips = (config.filters ?? []).filter(isActive);
  const count = verdict.value;
  const tone = TONE[verdict.level];
  const preview = items.slice(0, 4);
  const more = Math.max(0, items.length - preview.length);

  const nameOf = (item: any) => String(valueFor(item, "entity") ?? "—");

  return (
    <div className={`group relative rounded-2xl border overflow-hidden transition-colors
                     bg-white dark:bg-slate-900
                     ${error || count === 0 || verdict.level === "clear"
                        ? "border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20"
                        : `${tone.edge} ${tone.lift}`}`}>
      {/* The rail carries the verdict, so the state is readable before the
          number is. Clear is deliberately the quiet one: a board where every
          card shouts is a board nobody reads. */}
      <div aria-hidden="true"
        className={`absolute left-0 top-0 bottom-0 w-[3px] ${
          error ? "bg-rose-400" : count === 0 ? "bg-emerald-400/70" : tone.bar}`} />

      <div className="pl-5 pr-3 pt-3.5 pb-1 flex items-start gap-2">
        <button type="button" onClick={onOpen}
          className="min-w-0 flex-1 text-left group/title">
          <h3 className="text-[12px] font-bold uppercase tracking-wider text-slate-400
                         dark:text-slate-500 truncate group-hover/title:text-gh-blue transition-colors">
            {config.title}
          </h3>

          {/* The number, at the size the answer deserves. It led as a subtitle
              in the first version, which made four problems and none look
              identical across a grid. */}
          <div className="flex items-baseline gap-2 mt-1">
            {isLoading ? (
              <span className="inline-block h-8 w-16 rounded bg-slate-100 dark:bg-white/[0.06] animate-pulse" />
            ) : error ? (
              <span className="text-[15px] font-bold text-rose-600 dark:text-rose-400">
                Could not be read
              </span>
            ) : (
              <>
                <span className={`text-[34px] font-black tabular-nums leading-none tracking-[-0.03em]
                                  ${count === 0 ? "text-slate-300 dark:text-slate-600" : tone.figure}`}>
                  {count.toLocaleString()}
                </span>
                <span className="text-[12px] font-semibold text-slate-400 dark:text-slate-500">
                  {nounFor(entity, count)}
                </span>
              </>
            )}
          </div>

          {/* The unfiltered figure, always, when a filter is on. Without it
              this card and the Overview show two different numbers for the
              same check and neither says why. */}
          {filtered && !isLoading && !error && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 tabular-nums">
              narrowed from {unfiltered.toLocaleString()}
            </p>
          )}
        </button>

        {alarmCount > 0 && (
          <button type="button" onClick={onAlarm}
            title={`${alarmCount} alarm${alarmCount > 1 ? "s" : ""} on this card`}
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
                       text-[10.5px] font-bold bg-amber-500/10 text-amber-700
                       dark:text-amber-400 hover:bg-amber-500/20 transition-colors">
            <i className="ph-fill ph-bell text-[10px]" aria-hidden="true" />
            {alarmCount}
          </button>
        )}

        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100
                        focus-within:opacity-100 transition-opacity shrink-0">
          {[
            ["ph-bell", "Alarm", onAlarm],
            ["ph-funnel", "Filters", onFilters],
            ["ph-pencil-simple", "Edit", onEdit],
            ["ph-trash", "Remove", onRemove],
          ].map(([icon, label, fn]) => (
            <button key={label as string} type="button" onClick={fn as () => void}
              title={label as string} aria-label={`${label} ${config.title}`}
              className="w-7 h-7 rounded-lg grid place-items-center text-slate-400
                         hover:text-slate-900 dark:hover:text-white
                         hover:bg-slate-100 dark:hover:bg-white/[0.08] transition-colors">
              <i className={`ph-bold ${icon} text-[12.5px]`} aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="px-5 pb-2 flex flex-wrap gap-1">
          {chips.map(f => (
            <button key={f.column} type="button" onClick={onFilters}
              className="px-2 py-0.5 rounded-md text-[10.5px] font-semibold
                         bg-gh-blue/10 dark:bg-blue-400/15 text-gh-blue dark:text-blue-300
                         hover:bg-gh-blue/20 transition-colors max-w-full truncate">
              {describeFilter(f, labels.get(f.column) ?? f.column)}
            </button>
          ))}
        </div>
      )}

      <div className="px-5 pb-4">
        {isLoading ? (
          <div className="grid gap-1.5">
            {[0, 1, 2].map(i => (
              <div key={i} className="h-4 rounded bg-slate-100 dark:bg-white/[0.06] animate-pulse"
                style={{ width: `${80 - i * 14}%` }} />
            ))}
          </div>
        ) : error ? (
          <p className="text-[12px] text-rose-600 dark:text-rose-400 leading-relaxed">
            {error.message}
          </p>
        ) : items.length === 0 ? (
          /* Two different nothings, and the difference is the whole point of
             having put a filter on. */
          <p className="text-[12px] text-slate-400 dark:text-slate-500">
            {filtered && unfiltered > 0
              ? `Nothing matches your filters. The check found ${unfiltered.toLocaleString()}.`
              : "Nothing found."}
          </p>
        ) : (
          <>
            <ul className="grid gap-1">
              {preview.map((item: any, i: number) => (
                <li key={i} className="flex items-center gap-2 text-[12px] min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    item.status === "pass" ? "bg-emerald-500"
                      : item.status === "fail" ? "bg-rose-500"
                      : "bg-slate-300 dark:bg-slate-600"}`} />
                  <span className="font-medium text-slate-700 dark:text-slate-200 truncate"
                    title={nameOf(item)}>
                    {nameOf(item)}
                  </span>
                  {item.owner && (
                    <span className="ml-auto shrink-0 text-[10.5px] font-mono text-slate-400
                                     dark:text-slate-500 truncate max-w-[38%]" title={item.owner}>
                      {item.owner}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {more > 0 && (
              <button type="button" onClick={onOpen}
                className="mt-2 text-[11.5px] font-semibold text-slate-400 dark:text-slate-500
                           hover:text-gh-blue transition-colors">
                and {more.toLocaleString()} more →
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
