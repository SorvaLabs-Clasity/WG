import { useMemo } from "react";
import type { Activity } from "../types/Activity";
import { TYPE } from "../design";
import UserAvatar from "./UserAvatar";
import { importantLabel } from "../lib/importantEvents";

/**
 * The same rows as the table, read as a story instead of a spreadsheet.
 *
 * The table is the right shape for working: seven columns you can sort, resize
 * and read a diff out of. It is the wrong shape for the question people
 * actually open this tab with, which is "what happened last night", because
 * answering that from a table means reading timestamps and doing the grouping
 * in your head.
 *
 * So this groups by day, puts a rail down the side, and lets the density of
 * the rail carry the volume. Same data, same filters, same order; only the
 * arrangement differs.
 *
 * A row opens the same detail panel a table row opens, which is a modal over
 * the page rather than part of the table, so undo, redo, retry and the diff are
 * all reachable from here without duplicating any of them. It used to switch
 * back to the table first, which threw away the view somebody had deliberately
 * chosen in order to show them something they could have seen without leaving
 * it.
 */

const SOURCE_DOT: Record<string, string> = {
  github: "bg-indigo-500",
  aws: "bg-amber-500",
  app: "bg-emerald-500",
};

export default function ActivityTimeline({
  entries, onOpen, categoryOf,
}: {
  entries: Activity[];
  /** Open this row's detail panel, in place. */
  onOpen: (entry: Activity) => void;
  categoryOf: (action: string) => string;
}) {
  /**
   * Grouped by calendar day in the reader's own zone.
   *
   * Not by 24-hour blocks from now: "yesterday" has to mean the day somebody
   * remembers, or the grouping is arithmetic rather than memory.
   */
  const days = useMemo(() => {
    const out: { key: string; label: string; rows: Activity[] }[] = [];
    for (const e of entries) {
      const d = new Date(e.timestamp);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(e);
      else out.push({ key, label: dayLabel(d), rows: [e] });
    }
    return out;
  }, [entries]);

  if (entries.length === 0) return null;

  return (
    <div className="relative">
      {days.map(day => (
        <section key={day.key} className="relative">
          {/* Sticky, so the day you are reading stays named while you scroll
              through a busy one.
              Painted in the *card's* colour, not the page's. It used the page
              background, and this list sits inside a white card, so the header
              laid a grey rectangle over it: a box with a hard edge exactly
              where the rule ended, which read as a rendering fault rather than
              as a heading. */}
          <div className="sticky top-0 z-10 flex items-center gap-3 py-2.5
                          bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
              {day.label}
            </h3>
            <div className="flex-1 h-px bg-slate-200/80 dark:bg-white/10" />
            <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
              {day.rows.length}
            </span>
          </div>

          <ol className="relative pl-6 pb-3">
            {/* The rail. Behind the dots, stopping at the last one so it does
                not trail into the next day's heading. */}
            <div className="absolute left-[7px] top-2 bottom-4 w-px bg-slate-200 dark:bg-white/10"
                 aria-hidden="true" />

            {day.rows.map(e => {
              const cat = categoryOf(e.action);
              const important = e.action === "security.alert";
              return (
                <li key={e.id} className="relative">
                  {/* Ringed in the card's colour so the rail appears to pass
                      behind the dot. In the page colour it drew a pale halo on
                      a white card. */}
                  <span className={`absolute -left-6 top-[13px] w-[13px] h-[13px] rounded-full
                                    border-[3px] border-white dark:border-slate-900
                                    ${important ? "bg-rose-500" : SOURCE_DOT[cat] ?? "bg-slate-400"}`}
                        aria-hidden="true" />
                  <button
                    onClick={() => onOpen(e)}
                    className="w-full text-left py-2 px-3 -ml-1 rounded-lg
                               hover:bg-white dark:hover:bg-white/[0.05] transition-colors
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 dark:focus-visible:ring-white/25">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[13.5px] font-semibold text-slate-800 dark:text-slate-100">
                        {important ? importantLabel(e.importantKind) : humanAction(e.action)}
                      </span>
                      {important && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/50
                                         text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900 font-medium">
                          important
                        </span>
                      )}
                      {e.detailed && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700/70
                                         text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-600 font-medium">
                          detailed
                        </span>
                      )}
                      <span className="ml-auto text-[11.5px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                        {new Date(e.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 mt-1 min-w-0">
                      <UserAvatar login={e.actor} size={16} />
                      <span className="text-[12.5px] text-slate-500 dark:text-slate-400 truncate">
                        <span className="font-medium text-slate-600 dark:text-slate-300">{e.actor}</span>
                        {e.repo && <> · {e.repo}</>}
                        {e.details && <> · {e.details}</>}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** "github.push" reads as "Push" once the stream is already a coloured dot. */
function humanAction(action: string): string {
  const tail = action.includes(".") ? action.slice(action.indexOf(".") + 1) : action;
  const words = tail.replace(/[._]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Today and yesterday by name, everything else by date.
 *
 * A heading reading "27 August" for today is technically right and makes the
 * reader work out that it is today.
 */
function dayLabel(d: Date): string {
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}
