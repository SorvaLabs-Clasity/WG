import { useMemo } from "react";
import type { Activity } from "../types/Activity";
import { TYPE } from "../design";
import UserAvatar from "./UserAvatar";
import { importantLabel } from "../lib/importantEvents";

/**
 * The same rows as the table, read as a story instead of a spreadsheet.
 *
 * The table suits working: seven sortable, resizable columns with a diff in
 * them. It does not suit "what happened last night", which from a table means
 * reading timestamps and grouping in your head. So this groups by day and lets
 * the density of a rail carry the volume. Same data, same filters, same order.
 *
 * A row opens the same detail modal a table row opens, so undo, redo, retry and
 * the diff are reachable without switching view and throwing away the
 * arrangement somebody deliberately chose.
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
                          bg-ink/95 dark:bg-paper/95 ">
            <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
              {day.label}
            </h3>
            <div className="flex-1 h-px bg-slate-200/80 dark:bg-ink/10" />
            <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
              {day.rows.length}
            </span>
          </div>

          <ol className="relative pl-6 pb-3">
            {/* The rail. Behind the dots, stopping at the last one so it does
                not trail into the next day's heading. */}
            <div className="absolute left-[7px] top-2 bottom-4 w-px bg-slate-200 dark:bg-ink/10"
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
                                    border-[3px] border-white dark:border-rule
                                    ${important ? "bg-rose-500" : SOURCE_DOT[cat] ?? "bg-slate-400"}`}
                        aria-hidden="true" />
                  <button
                    onClick={() => onOpen(e)}
                    className="w-full text-left py-2 px-3 -ml-1 rounded-lg
                               hover:bg-white dark:hover:bg-ink/[0.05] transition-colors
                               focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/15 dark:focus-visible:ring-ink/25">
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
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-paper-3/70
                                         text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-rule font-medium">
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
