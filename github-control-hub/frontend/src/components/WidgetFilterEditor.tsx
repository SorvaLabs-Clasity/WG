import { useMemo, useState } from "react";
import { useWidgetData } from "../pages/AnalyticsPage";
import { useUpdateWidget } from "../hooks/useWidgets";
import { widgetColumns } from "../lib/widgetColumns";
import {
  filterableColumns, isActive, valueFor, applyWidgetFilters,
  type WidgetFilter, type FilterableColumn,
} from "../lib/widgetFilters";
import { Button, Note, Spinner, SURFACE, TYPE } from "../design";
import type { WidgetConfig } from "../api/widgets";

/**
 * Narrowing one personal widget, column by column.
 *
 * Opened against a widget that already exists, and reading its real rows,
 * because the choices only make sense once the data is in hand: which columns a
 * check returns depends on the check, and the values worth picking from are the
 * ones actually present. Offering a guess at them before the widget has run
 * would produce a form full of fields that turn out not to apply.
 *
 * Reads live rather than from the stored snapshot. A snapshot is trimmed to fit
 * the row limit, and building a filter against a list that is missing rows means
 * choosing from options that are not all there.
 */
export default function WidgetFilterEditor({ config, onClose }: {
  config: WidgetConfig;
  onClose: () => void;
}) {
  // `allItems`, not `items`: the choices have to be drawn from the rows before
  // this widget's own filters, or a narrowed board could never be widened
  // again — the value you wanted would have been filtered out of the list of
  // values to pick from.
  const { allItems: unfiltered, isLoading, error } = useWidgetData(
    config, { needAllRows: true, live: true });
  const update = useUpdateWidget();

  const columns = useMemo(() => widgetColumns({
    type: config.type,
    presetId: config.presetId,
    hasStatus: unfiltered.some((i: any) => i.status),
    hasOwner: unfiltered.some((i: any) => "owner" in i),
    hasVisibility: unfiltered.some((i: any) => "visibility" in i),
    hasBypasses: unfiltered.some((i: any) => typeof i.bypasses === "number"),
  }), [config.type, config.presetId, unfiltered]);

  const available = useMemo(
    () => filterableColumns(columns, unfiltered), [columns, unfiltered]);

  const [draft, setDraft] = useState<WidgetFilter[]>(() => config.filters ?? []);
  const [saveError, setSaveError] = useState("");

  const filterFor = (id: string) => draft.find(f => f.column === id);
  const setFilter = (id: string, next: Partial<WidgetFilter> | null) => {
    setDraft(list => {
      const rest = list.filter(f => f.column !== id);
      if (next === null) return rest;
      const merged = { ...(filterFor(id) ?? { column: id }), ...next } as WidgetFilter;
      return isActive(merged) ? [...rest, merged] : rest;
    });
  };

  const preview = useMemo(() => {
    // Deliberately the same function the board uses, not a second
    // implementation: a preview that disagreed with the result would be worse
    // than no preview.
    return applyWidgetFilters(unfiltered, draft).length;
  }, [draft, unfiltered]);

  const save = async () => {
    setSaveError("");
    try {
      await update.mutateAsync({
        id: config.id,
        data: { filters: draft.filter(isActive) } as any,
      });
      onClose();
    } catch (e) {
      setSaveError((e as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/45  p-4"
      role="dialog" aria-modal="true" aria-label={`Filters for ${config.title}`}>
      <div className={`${SURFACE.card} w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden`}>
        <div className="px-5 pt-4 pb-3 border-b border-slate-200 dark:border-ink/10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="display text-[1.1875rem] text-ink truncate">
                Narrow “{config.title}”
              </h3>
              <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
                The check still looks at the whole organization. This decides
                which of its rows reach your board.
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close"
              className="shrink-0 w-7 h-7 rounded-lg grid place-items-center
                         text-slate-400 hover:text-slate-900 dark:hover:text-ink
                         hover:bg-slate-100 dark:hover:bg-ink/[0.08] transition-colors">
              <i className="ph-bold ph-x text-[13px]" aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid gap-4">
          {isLoading ? (
            <div className="py-12 flex justify-center"><Spinner /></div>
          ) : error ? (
            <Note intent="warn">
              This check could not be read just now, so there is nothing to build
              a filter from: {(error as Error).message}
            </Note>
          ) : unfiltered.length === 0 ? (
            /* Nothing to choose from, said plainly. A form of empty dropdowns
               reads as broken rather than as a check that found nothing. */
            <Note intent="info">
              This check currently returns no rows, so there are no values to
              filter on yet. Come back once it finds something.
            </Note>
          ) : available.length === 0 ? (
            <Note intent="info">
              This check returns a single number rather than a table, so there
              are no columns to narrow.
            </Note>
          ) : (
            available.map(col => (
              <ColumnFilter key={col.id} column={col} items={unfiltered}
                value={filterFor(col.id)} onChange={next => setFilter(col.id, next)} />
            ))
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-slate-200 dark:border-ink/10
                        flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[12px] text-slate-500 dark:text-slate-400 tabular-nums">
            {draft.filter(isActive).length === 0
              ? `${unfiltered.length.toLocaleString()} rows, unnarrowed`
              : `${preview.toLocaleString()} of ${unfiltered.length.toLocaleString()} rows kept`}
          </p>
          <div className="flex items-center gap-2">
            {draft.filter(isActive).length > 0 && (
              <Button onClick={() => setDraft([])}>Clear all</Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={update.isPending} onClick={save}>
              {update.isPending ? "Saving…" : "Save filters"}
            </Button>
          </div>
        </div>

        {saveError && <div className="px-5 pb-4"><Note intent="danger">{saveError}</Note></div>}
      </div>
    </div>
  );
}

/**
 * One column's control, shaped by what the column holds.
 *
 * Three shapes rather than one text box for everything: a set of known values
 * is a list to tick, a count is a range, and a repository name is something you
 * type. A single free-text field for all three would make "status is fail"
 * something you had to spell correctly.
 */
function ColumnFilter({ column, items, value, onChange }: {
  column: FilterableColumn;
  items: any[];
  value?: WidgetFilter;
  onChange: (next: Partial<WidgetFilter> | null) => void;
}) {
  const [typed, setTyped] = useState("");
  const active = value ? isActive(value) : false;

  /**
   * What this one filter keeps, on its own.
   *
   * The count at the bottom of the dialog is every filter together, so a zero
   * there says only that something is wrong. This says which control caused it,
   * next to that control — which is the difference between "0 matches" and
   * "the Owner filter matches nothing, and here is what Owner actually holds".
   */
  const kept = useMemo(
    () => (active && value ? applyWidgetFilters(items, [value]).length : items.length),
    [active, value, items]);

  /** How many rows carry each value, so a choice that matches nothing is visible. */
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const item of items) {
      const v = valueFor(item, column.id);
      if (v === undefined || v === null || v === "") continue;
      const key = String(v);
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [items, column.id]);

  /**
   * Real values from the data, for a column somebody has to type into.
   *
   * The commonest way to get nothing back is to filter the wrong column: a
   * username typed into Entity, where the values are repository names, matches
   * nothing and looks like a broken filter. Showing what is in there makes that
   * mistake self-correcting.
   */
  const examples = useMemo(
    () => [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([v]) => v),
    [counts]);

  const missing = items.length - counts.size === items.length && counts.size === 0;

  const bounds = useMemo(() => {
    if (column.kind !== "number") return null;
    const nums = items.map(i => Number(valueFor(i, column.id)))
      .filter(n => Number.isFinite(n));
    return nums.length ? { lo: Math.min(...nums), hi: Math.max(...nums) } : null;
  }, [column, items]);

  const values = value?.values ?? [];
  const addValue = (v: string) => {
    const clean = v.trim();
    if (!clean || values.includes(clean)) return;
    onChange({ values: [...values, clean] });
  };

  return (
    <div className={`rounded-xl border p-3.5 transition-colors ${
      active
        ? "border-gh-blue/40 bg-ink/[0.04] dark:bg-blue-400/[0.06]"
        : "border-slate-200 dark:border-ink/10"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-[13px] font-bold text-slate-900 dark:text-ink">
            {column.label}
          </span>
          <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
            {column.kind === "number" ? "a range" : column.kind === "enum" ? "pick values" : "match text"}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[11px] font-bold tabular-nums ${
            active && kept === 0 ? "text-rose-600 dark:text-rose-400"
              : active ? "text-emerald-600 dark:text-emerald-400"
              : "text-slate-300 dark:text-slate-600"}`}>
            {active ? `${kept} of ${items.length}` : `${items.length} rows`}
          </span>
          {active && (
            <button type="button" onClick={() => onChange(null)}
              className="textlink caps transition-colors">
              Clear
            </button>
          )}
        </div>
      </div>

      {/* The column has nothing in it at all. Said before somebody types into
          it and concludes the filter is broken. */}
      {missing && (
        <p className="text-[11.5px] text-amber-700 dark:text-amber-400 mt-1.5">
          No row in this check reports a {column.label.toLowerCase()}, so a
          filter here would match nothing.
        </p>
      )}

      {column.kind === "number" ? (
        <div className="flex items-center gap-2 mt-2.5">
          <input type="number" inputMode="numeric" placeholder={bounds ? `min ${bounds.lo}` : "min"}
            value={value?.min ?? ""} className={`${SURFACE.input} max-w-[140px]`}
            onChange={e => onChange({ min: e.target.value === "" ? null : Number(e.target.value) })} />
          <span className="text-[12px] text-slate-400">to</span>
          <input type="number" inputMode="numeric" placeholder={bounds ? `max ${bounds.hi}` : "max"}
            value={value?.max ?? ""} className={`${SURFACE.input} max-w-[140px]`}
            onChange={e => onChange({ max: e.target.value === "" ? null : Number(e.target.value) })} />
        </div>
      ) : column.kind === "enum" ? (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {column.options.map(opt => {
            const on = values.includes(opt);
            return (
              <button key={opt} type="button"
                onClick={() => onChange({ values: on ? values.filter(v => v !== opt) : [...values, opt] })}
                aria-pressed={on}
                className={`px-2.5 py-1 rounded-lg text-[12px] font-semibold transition-colors border
                            inline-flex items-center gap-1.5 ${
                  on
                    ? "bg-slate-900 dark:bg-white text-reverse dark:text-slate-900 border-transparent"
                    : "border-slate-200 dark:border-ink/10 text-slate-600 dark:text-slate-300 hover:border-slate-400"}`}>
                {opt}
                {/* How many rows carry it. A choice that would keep nothing is
                    worth seeing before it is made, not after. */}
                <span className={`text-[10px] tabular-nums font-bold ${
                  on ? "opacity-60" : "text-slate-400 dark:text-slate-500"}`}>
                  {counts.get(opt) ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex gap-2 mt-2.5">
            <input
              value={typed} onChange={e => setTyped(e.target.value)}
              placeholder="Type a name and press Enter"
              className={SURFACE.input}
              onKeyDown={e => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                addValue(typed);
                setTyped("");
              }} />
            <Button onClick={() => { addValue(typed); setTyped(""); }} disabled={!typed.trim()}>
              Add
            </Button>
          </div>
          {values.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {values.map(v => (
                <span key={v} className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg
                                         text-[12px] font-semibold bg-slate-100 dark:bg-ink/[0.08]
                                         text-slate-700 dark:text-slate-200">
                  {v}
                  <button type="button" aria-label={`Remove ${v}`}
                    onClick={() => onChange({ values: values.filter(x => x !== v) })}
                    className="w-4 h-4 rounded grid place-items-center text-slate-400
                               hover:text-rose-600 dark:hover:text-rose-400 transition-colors">
                    <i className="ph-bold ph-x text-[9px]" aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Matching is on part of the value, not all of it, because what
              people type is a name they half-remember. Said here so a filter
              that keeps more than expected is explainable. */}
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1.5 leading-relaxed">
            Matches any part of the value, ignoring case.
            {examples.length > 0 && (
              <> This column holds things like{" "}
                {examples.map((e, i) => (
                  <span key={e}>
                    {i > 0 && ", "}
                    <button type="button" onClick={() => addValue(e)}
                      className="font-mono text-[10.5px] px-1 py-0.5 rounded
                                 bg-slate-200/70 dark:bg-ink/[0.08]
                                 text-slate-600 dark:text-slate-300 hover:text-gh-blue transition-colors">
                      {e}
                    </button>
                  </span>
                ))}.
              </>
            )}
          </p>
          {active && kept === 0 && (
            <p className="text-[11.5px] text-rose-600 dark:text-rose-400 mt-1.5 leading-relaxed">
              Nothing in this column matches. Check it is the column you meant:
              Entity holds the repository, user or team a row is about, and Owner
              holds who to ask about it.
            </p>
          )}
        </>
      )}

      {column.kind !== "number" && (
        <div className="flex items-center gap-1 mt-2.5">
          {(["include", "exclude"] as const).map(mode => (
            <button key={mode} type="button" onClick={() => onChange({ mode })}
              aria-pressed={(value?.mode ?? "include") === mode}
              className={`px-2.5 py-1 rounded-lg text-[11.5px] font-bold transition-colors ${
                (value?.mode ?? "include") === mode
                  ? "bg-slate-200 dark:bg-ink/[0.12] text-slate-900 dark:text-ink"
                  : "text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200"}`}>
              {mode === "include" ? "Keep these" : "Hide these"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
