import React, { useState, useMemo, useEffect, useCallback } from "react";
import { Page, RefreshButton, Button, Note, Empty, Spinner, useCountUp, TYPE, SURFACE, enter } from "../design";
import { useAuth } from "../App";
import { useSecurityQuery, useGraphMeta, useTriggerAggregation } from "../hooks/useGraph";
import { useDependencies } from "../hooks/useDependencies";
import { useRepos } from "../hooks/useRepos";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import { useWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "../hooks/useWidgets";
import { usePermissions } from "../hooks/usePermissions";
import { useOrgConfig } from "../hooks/useOrgConfig";
import type { WidgetConfig } from "../api/widgets";
import { TagInput } from "../components/TagInput";

type WidgetType = "preset" | "query";
type DisplayType = "metric" | "table";
type PresetId = "dependabot" | "bypasses" | "vuln-repos";

/**
 * Severity filter for the "repositories with vulnerabilities" preset. Stored in
 * queryParam so it survives a reload with the rest of the widget's config.
 */
const SEVERITY_CHOICES = [
  ["any", "Any severity"],
  ["critical", "Critical only"],
  ["high", "High and above"],
  ["medium", "Medium and above"],
  ["low", "Low and above"],
] as const;

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };
const THRESHOLD: Record<string, number> = { any: 1, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * The board.
 *
 * This was a grid of equal cards, each with a large centred number. Equal cards
 * say every question matters equally, which is the one thing that is never
 * true: 347 repositories with an unprotected default branch and an empty-teams
 * check that found nothing were the same size, in the same place, in the same
 * shade.
 *
 * So size follows state. A check with findings takes a full band with the count
 * set large enough to read across a room; a check with nothing to report
 * collapses to a single quiet line in a register at the bottom. The page
 * physically changes shape as the organisation does — which is the first design
 * principle in /.impeccable.md, applied to layout rather than to colour alone.
 *
 * Everything is left-aligned against a common edge so the counts form a column
 * the eye can run down. Nothing is centred; centred numbers in a grid read as
 * decoration.
 */

type Level = "danger" | "warn" | "info" | "clear";

const ORDER: Record<Level, number> = { danger: 0, warn: 1, info: 2, clear: 3 };

interface Verdict {
  level: Level;
  value: number;
  denominator: number | null;
  caption: string;
  badge: string | null;
}

/**
 * What a widget's numbers mean.
 *
 * Three shapes, because a query result is not one kind of thing: some report
 * their own pass/fail, some find problems, and some simply answer a question
 * and carry no verdict at all. Treating the third as the second is how "which
 * repositories have a main branch" once read as CRITICAL.
 */
function verdictFor(items: any[], total: number | null, config: WidgetConfig): Verdict {
  const hasStatus = items.some((i: any) => i.status);
  if (hasStatus) {
    const pass = items.filter((i: any) => i.status === "pass").length;
    const rate = items.length ? Math.round((pass / items.length) * 100) : 0;
    return {
      level: rate === 100 ? "clear" : rate >= 80 ? "warn" : "danger",
      value: items.length - pass,
      denominator: items.length,
      caption: items.length - pass === 1 ? "failing" : "failing",
      badge: rate === 100 ? "all passing" : `${rate}% passing`,
    };
  }

  const option = config.type === "query" ? QUERY_OPTIONS.find(q => q.id === config.queryId) : undefined;
  const found = items.length;

  if (config.type === "query" && (option as any)?.informational) {
    return { level: "info", value: found, denominator: total, caption: "matching", badge: null };
  }

  const share = total ? found / total : null;
  return {
    level: found === 0 ? "clear" : share !== null && share >= 0.1 ? "danger" : "warn",
    value: found,
    denominator: total,
    caption: found === 1 ? "repository" : "repositories",
    badge: null,
  };
}

const TONE: Record<Level, { rail: string; figure: string; chip: string; wash: string }> = {
  danger: {
    rail: "bg-rose-500 dark:bg-rose-400",
    figure: "text-rose-600 dark:[color:#ff8095]",
    chip: "bg-rose-50 text-rose-700 dark:bg-rose-500/[0.14] dark:text-rose-300",
    wash: "bg-rose-50/40 dark:bg-rose-500/[0.05]",
  },
  warn: {
    rail: "bg-amber-500 dark:bg-amber-400",
    figure: "text-amber-600 dark:[color:#ffc14d]",
    chip: "bg-amber-50 text-amber-700 dark:bg-amber-500/[0.14] dark:text-amber-300",
    wash: "bg-amber-50/40 dark:bg-amber-500/[0.05]",
  },
  info: {
    rail: "bg-blue-500 dark:bg-blue-400",
    figure: "text-blue-600 dark:[color:#6bb4ff]",
    chip: "bg-blue-50 text-blue-700 dark:bg-blue-500/[0.14] dark:text-blue-300",
    wash: "",
  },
  clear: {
    rail: "bg-emerald-500 dark:bg-emerald-400",
    figure: "text-emerald-600 dark:[color:#3ddc97]",
    chip: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/[0.14] dark:text-emerald-300",
    wash: "",
  },
};

export default function AnalyticsPage() {
  const { user } = useAuth();
  const { data: widgets = [], isLoading: widgetsLoading, isFetching: widgetsFetching, refetch: refetchWidgets } = useWidgets();
  const createWidget = useCreateWidget();
  const updateWidget = useUpdateWidget();
  const deleteWidgetMut = useDeleteWidget();

  // One dashboard, shared by everyone, so editing it is gated like the rest of
  // the org-wide configuration. The server enforces it; this only stops
  // offering controls that would be refused.
  const { data: permissions } = usePermissions();
  const canEditDashboard = permissions?.isControlHubAdmin ?? false;

  const { data: orgConfig } = useOrgConfig();
  const orgName = orgConfig?.org || "";
  const { data: graphMeta } = useGraphMeta();
  const aggregation = useTriggerAggregation();
  const graphEmpty = graphMeta?.edgeCount === 0;

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  /**
   * Each row reports what it found once its data arrives.
   *
   * The parent cannot work this out itself: the queries behind a widget depend
   * on its configuration, so evaluating N widgets means N hook calls and the
   * list length changes. Reporting upward keeps the hooks where they belong and
   * still lets the page know its own posture.
   */
  const [levels, setLevels] = useState<Record<string, Level>>({});
  const report = useCallback((id: string, level: Level) => {
    setLevels(prev => (prev[id] === level ? prev : { ...prev, [id]: level }));
  }, []);

  const posture = useMemo(() => {
    const seen = widgets.map(w => levels[w.id]).filter(Boolean) as Level[];
    const attention = seen.filter(l => l === "danger" || l === "warn").length;
    return {
      attention,
      answered: seen.length,
      total: widgets.length,
      worst: seen.includes("danger") ? "danger" : seen.includes("warn") ? "warn" : "clear",
    };
  }, [widgets, levels]);

  const handleSave = (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => {
    if (editingWidget) {
      updateWidget.mutate({ id: editingWidget.id, data: config }, { onSuccess: () => setEditingWidget(null) });
    } else {
      createWidget.mutate(config, { onSuccess: () => setShowAddModal(false) });
    }
  };

  const removeWidget = (id: string) => {
    if (window.confirm("Remove this from the dashboard?")) deleteWidgetMut.mutate(id);
  };

  return (
    <Page user={user}>
      {/* ── Posture. Stated in words, at a size that does not need looking for. ── */}
      <header className="mb-10" style={enter(0)}>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <p className={`${TYPE.label} text-slate-400 dark:text-slate-500 mb-3`}>
              {orgName || "Organisation"} · {posture.total} {posture.total === 1 ? "check" : "checks"}
            </p>
            <h1 className="text-[38px] sm:text-[52px] font-black tracking-[-0.035em] leading-[1.02] max-w-[18ch]">
              {widgetsLoading ? (
                <span className="text-slate-300 dark:text-slate-700">Reading the organisation…</span>
              ) : posture.total === 0 ? (
                <>Nothing is being watched yet.</>
              ) : posture.answered === 0 ? (
                <span className="text-slate-300 dark:text-slate-700">Working it out…</span>
              ) : posture.attention === 0 ? (
                <>Everything checked is <span className={TONE.clear.figure}>clear</span>.</>
              ) : (
                <>
                  <span className={TONE[posture.worst as Level].figure}>{posture.attention}</span>
                  {" "}of {posture.answered} checks need attention.
                </>
              )}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0 pt-1">
            <RefreshButton busy={widgetsFetching} onRefresh={() => refetchWidgets()} />
            <Button
              onClick={() => aggregation.mutate()}
              disabled={aggregation.isPending}
              className="whitespace-nowrap"
            >
              <i className={`ph-bold ph-arrows-clockwise mr-2 ${aggregation.isPending ? "animate-spin" : ""}`}></i>
              {aggregation.isPending ? "Syncing" : "Sync data"}
            </Button>
            {canEditDashboard && (
              <Button variant="primary" onClick={() => setShowAddModal(true)}>
                <i className="ph-bold ph-plus mr-2"></i>Add check
              </Button>
            )}
          </div>
        </div>
      </header>

      {graphEmpty && (
        <div style={enter(1)} className="mb-6">
          <Note intent="warn">
            The graph has no data, so anything reading from it will come back empty. Sync data to build it.
          </Note>
        </div>
      )}
      {aggregation.isError && (
        <div style={enter(1)} className="mb-6">
          <Note intent="danger">Sync failed — {(aggregation.error as Error)?.message || "unknown error"}.</Note>
        </div>
      )}

      {widgetsLoading ? (
        <Spinner />
      ) : widgets.length === 0 ? (
        <Empty
          title="No checks yet"
          body="A check is a question about the organisation — which repositories have an unprotected default branch, who holds admin they were never granted, which packages are exposing you. Add one and it appears here, loudest first."
          action={canEditDashboard
            ? <Button variant="primary" onClick={() => setShowAddModal(true)}>Add the first check</Button>
            : undefined}
        />
      ) : (
        /* Flex order does the sorting, so a row can place itself the moment its
           own data lands rather than waiting for the page to collect everyone's. */
        <div className="flex flex-col gap-3">
          {widgets.map((w, i) => (
            <WidgetRow
              key={w.id}
              config={w}
              index={i}
              open={openId === w.id}
              onToggle={() => setOpenId(openId === w.id ? null : w.id)}
              onReport={report}
              canEdit={canEditDashboard}
              onEdit={() => setEditingWidget(w)}
              onRemove={() => removeWidget(w.id)}
              graphEmpty={graphEmpty}
              orgName={orgName}
            />
          ))}
        </div>
      )}

      {(showAddModal || editingWidget) && (
        <WidgetFormModal
          onClose={() => { setShowAddModal(false); setEditingWidget(null); }}
          onSave={handleSave}
          isSaving={createWidget.isPending || updateWidget.isPending}
          initialData={editingWidget || undefined}
        />
      )}
    </Page>
  );
}

/**
 * One check.
 *
 * Renders at one of two weights. With findings it is a band: a thick rail, the
 * count at 44px, the question beside it. With nothing to report it is a single
 * line — still present, still clickable, but taking the space a settled matter
 * deserves rather than a card's worth.
 */
function WidgetRow({
  config, index, open, onToggle, onReport, canEdit, onEdit, onRemove, graphEmpty, orgName,
}: {
  config: WidgetConfig; index: number; open: boolean; onToggle: () => void;
  onReport: (id: string, level: Level) => void;
  canEdit: boolean; onEdit: () => void; onRemove: () => void;
  graphEmpty?: boolean; orgName?: string;
}) {
  const { items, isLoading, total } = useWidgetData(config);
  const verdict = useMemo(() => verdictFor(items, total, config), [items, total, config]);

  useEffect(() => {
    if (!isLoading) onReport(config.id, verdict.level);
  }, [isLoading, verdict.level, config.id, onReport]);

  const tone = TONE[verdict.level];
  const quiet = verdict.level === "clear" && !open;
  const n = useCountUp(verdict.value);

  if (isLoading) {
    return (
      <div style={{ order: 2, ...enter(index) }}
        className={`${SURFACE.card} h-[68px] flex items-center gap-4 px-5`}>
        <span className="w-1.5 h-8 rounded-full bg-slate-200 dark:bg-white/10 animate-pulse" />
        <span className="h-4 w-40 rounded bg-slate-100 dark:bg-white/[0.07] animate-pulse" />
      </div>
    );
  }

  return (
    <section
      style={{ order: ORDER[verdict.level], ...enter(index) }}
      className={`${SURFACE.card} overflow-hidden transition-shadow duration-200 ${open ? "shadow-xl" : ""}`}
    >
      <div className="flex items-stretch">
        <div className={`w-1.5 shrink-0 ${tone.rail} transition-colors duration-300`} />

        <button
          onClick={onToggle}
          aria-expanded={open}
          className={`flex-1 min-w-0 text-left flex items-center gap-5 transition-colors ${tone.wash}
            ${quiet ? "px-5 py-3" : "px-6 py-5"} hover:bg-slate-900/[0.02] dark:hover:bg-white/[0.02]`}
        >
          {quiet ? (
            <>
              <i className={`ph-fill ph-check-circle text-lg shrink-0 ${tone.figure}`}></i>
              <span className="flex-1 min-w-0 text-sm font-bold text-slate-600 dark:text-slate-300 truncate">
                {config.title}
              </span>
              <span className="text-[12px] text-slate-400 dark:text-slate-500 shrink-0">
                {verdict.badge ?? "nothing found"}
              </span>
            </>
          ) : (
            <>
              <span className="shrink-0 w-[92px] sm:w-[116px]">
                <span className={`block text-[40px] sm:text-[48px] font-black tabular-nums leading-none tracking-tight ${tone.figure}`}>
                  {n}
                </span>
                {verdict.denominator !== null && (
                  <span className="block text-[12px] font-semibold text-slate-400 dark:text-slate-500 tabular-nums mt-1.5">
                    of {verdict.denominator}
                  </span>
                )}
              </span>

              <span className="flex-1 min-w-0">
                <span className={`block ${TYPE.heading} text-slate-900 dark:text-white truncate`}>
                  {config.title}
                </span>
                <span className="block text-[13px] text-slate-500 dark:text-slate-400 mt-1">
                  {verdict.caption}
                  {verdict.badge && <> · {verdict.badge}</>}
                </span>
              </span>
            </>
          )}

          <i className={`ph-bold ph-caret-down text-slate-300 dark:text-slate-600 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`}></i>
        </button>

        {canEdit && (
          <div className="flex items-center gap-1 pr-4 opacity-0 focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100 transition-opacity">
            <button onClick={onEdit} title="Edit"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors">
              <i className="ph-bold ph-pencil-simple text-sm"></i>
            </button>
            <button onClick={onRemove} title="Remove"
              className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 transition-colors">
              <i className="ph-bold ph-trash text-sm"></i>
            </button>
          </div>
        )}
      </div>

      {/* grid-template-rows rather than height: it animates without measuring,
          and without laying out the contents on every frame. */}
      <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
        <div className="overflow-hidden">
          <div className="border-t border-slate-100 dark:border-white/[0.07]">
            <WidgetDataTable config={config} items={items} graphEmpty={graphEmpty} orgName={orgName} />
          </div>
        </div>
      </div>
    </section>
  );
}

function useWidgetData(config: WidgetConfig) {
  const { data: depsData, isLoading: depsLoading } = useDependencies();
  const isBypass = config.type === "preset" && config.presetId === "bypasses";
  const { data: bypassData, isLoading: bypassLoading } = useSecurityQuery(isBypass ? "protection-bypasses-ranking" : null);

  const isQuery = config.type === "query";
  const { data: queryData, isLoading: queryLoading } = useSecurityQuery(isQuery ? config.queryId! : null, config.queryParam, config.queryAdvanced);

  const { data: repos } = useRepos();

  const { items, isLoading } = useMemo(() => {
    let rawItems: any[] = [];
    let loading = false;

    if (config.type === "preset") {
      if (config.presetId === "dependabot") {
        loading = depsLoading;
        const map = new Map<string, any>();
        if (depsData) {
          for (const dep of depsData) {
            if (dep.clean || dep.disabled) continue;
            if (!map.has(dep.repo)) map.set(dep.repo, { repo: dep.repo, total: 0, critical: 0, high: 0, medium: 0, low: 0 });
            const e = map.get(dep.repo)!;
            e.total++;
            if (dep.severity === "critical") e.critical++;
            else if (dep.severity === "high") e.high++;
            else if (dep.severity === "medium" || (dep.severity as string) === "moderate") e.medium++;
            else e.low++;
          }
        }
        rawItems = Array.from(map.values()).sort((a, b) => b.critical !== a.critical ? b.critical - a.critical : b.high !== a.high ? b.high - a.high : b.total - a.total);
      } else if (config.presetId === "vuln-repos") {
        // Reads the same ["dependencies"] query the Dependabot tab uses, so
        // adding this widget costs no additional GitHub requests — the list is
        // one request per repository and must not be fetched twice.
        loading = depsLoading;
        const min = THRESHOLD[config.queryParam || "any"] ?? 1;
        const map = new Map<string, any>();
        for (const dep of depsData ?? []) {
          if (dep.clean || dep.disabled || dep.scanning) continue;
          if ((SEVERITY_RANK[dep.severity] ?? 0) < min) continue;
          if (!map.has(dep.repo)) map.set(dep.repo, { repo: dep.repo, total: 0, worst: "low" });
          const e = map.get(dep.repo)!;
          e.total++;
          if ((SEVERITY_RANK[dep.severity] ?? 0) > (SEVERITY_RANK[e.worst] ?? 0)) e.worst = dep.severity;
        }
        rawItems = Array.from(map.values()).sort(
          (a, b) => (SEVERITY_RANK[b.worst] - SEVERITY_RANK[a.worst]) || b.total - a.total);
      } else if (config.presetId === "bypasses") {
        loading = bypassLoading;
        rawItems = bypassData || [];
      }
    } else {
      loading = queryLoading;
      rawItems = queryData || [];
    }

    return { items: rawItems, isLoading: loading };
  }, [config, depsData, depsLoading, bypassData, bypassLoading, queryData, queryLoading]);

  const isRepoQuery = config.type === "preset" || (config.type === "query" && config.queryId?.startsWith("repos-"));
  const total = isRepoQuery && repos ? repos.length : null;

  return { items, isLoading, total };
}

/* ─── Widget Card (Grid View) ─── */

function WidgetDataTable({ config, items, graphEmpty, orgName }: { config: WidgetConfig; items: any[]; graphEmpty?: boolean; orgName?: string }) {
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  if (items.length === 0) {
    return (
      <div className="p-12 text-center text-slate-500 dark:text-slate-400">
        {graphEmpty ? (
          <>
            <i className="ph-fill ph-database text-4xl text-amber-500 mb-3 block opacity-80"></i>
            <p className="font-medium text-slate-700 dark:text-slate-300 mb-1">No graph data available</p>
            <p className="text-sm">Use the "Sync Now" button above to pull data from GitHub before running queries.</p>
          </>
        ) : (
          <>
            <i className="ph-fill ph-check-circle text-4xl text-emerald-500 mb-3 block opacity-80"></i>
            No data matches this query or preset.
          </>
        )}
      </div>
    );
  }

  const hasStatus = items.some((i: any) => i.status);

  return (
    <>
      <table className="w-full text-left border-collapse">
        <thead className="bg-slate-50 dark:bg-slate-950 sticky top-0 z-10 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider border-b border-slate-200 dark:border-slate-700">
          <tr>
            <th className="px-6 py-3 w-16">#</th>
            <th className="px-6 py-3">Entity</th>

            {config.type === "preset" && config.presetId === "dependabot" && (
              <>
                <th className="px-6 py-3 text-center text-rose-600 dark:text-red-400">Critical</th>
                <th className="px-6 py-3 text-center text-orange-500 dark:text-orange-400">High</th>
                <th className="px-6 py-3 text-center text-amber-600 dark:text-amber-400">Medium</th>
                <th className="px-6 py-3 text-center text-slate-500 dark:text-slate-400">Low</th>
                <th className="px-6 py-3 text-center">Total</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "vuln-repos" && (
              <>
                <th className="px-6 py-3 text-center">Worst</th>
                <th className="px-6 py-3 text-center">Alerts</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "bypasses" && (
              <>
                <th className="px-6 py-3">Bypasses</th>
                <th className="px-6 py-3 w-full">Reason</th>
              </>
            )}
            {config.type === "query" && hasStatus && <th className="px-6 py-3 text-center w-[80px]">Status</th>}
            {config.type === "query" && <th className="px-6 py-3 w-full">Details</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-700 text-sm">
          {items.map((item: any, idx: number) => {
            const name = item.repo || item.user || item.team || "Unknown";
            return (
              <tr
                key={idx}
                className={`group hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors cursor-pointer ${idx % 2 === 1 ? 'bg-slate-50/50 dark:bg-slate-800/50' : ''}`}
                onClick={() => setSelectedItem(item)}
              >
                <td className="px-6 py-4 font-mono text-slate-400 dark:text-slate-500 text-xs">{String(idx + 1).padStart(3, "0")}</td>
                <td className="px-6 py-4">
                  <div className="font-bold text-slate-800 dark:text-slate-200">{name}</div>
                  {config.type === "query" && (
                    <div className="text-xs text-slate-400 dark:text-slate-500 font-mono">{item.repo ? "repository" : item.user ? "user" : item.team ? "team" : "unknown"}</div>
                  )}
                </td>

                {config.type === "preset" && config.presetId === "dependabot" && (
                  <>
                    <td className="px-6 py-4 text-center font-mono font-medium text-rose-600 dark:text-red-400">{item.critical || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-orange-500 dark:text-orange-400">{item.high || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-amber-600 dark:text-amber-400">{item.medium || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-slate-500 dark:text-slate-400">{item.low || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "vuln-repos" && (
                  <>
                    <td className="px-6 py-4 text-center">
                      <span className={`inline-flex px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wide ${
                        item.worst === "critical" ? "bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400"
                        : item.worst === "high" ? "bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400"
                        : item.worst === "medium" || item.worst === "moderate" ? "bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
                        : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400"}`}>
                        {item.worst}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "bypasses" && (
                  <>
                    <td className="px-6 py-4 font-mono font-bold text-rose-600 dark:text-red-400">{item.bypasses}</td>
                    <td className="px-6 py-4 text-sm text-slate-500 dark:text-slate-400 truncate">{item.reason}</td>
                  </>
                )}

                {config.type === "query" && hasStatus && (
                  <td className="px-6 py-4 text-center">
                    {item.status === "pass" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
                        <i className="fas fa-check-circle"></i> Pass
                      </span>
                    ) : item.status === "fail" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-50 dark:bg-red-950/50 text-rose-700 dark:text-red-400 border border-rose-200 dark:border-red-800">
                        <i className="fas fa-times-circle"></i> Fail
                      </span>
                    ) : null}
                  </td>
                )}
                {config.type === "query" && (
                  <td className="px-6 py-4 text-sm">
                    <span className={`block truncate max-w-xl ${item.status === "fail" ? "text-rose-700 dark:text-red-400" : "text-slate-800 dark:text-slate-200"}`}>{item.reason}</span>
                    {item.details && <span className="text-xs text-slate-500 dark:text-slate-400 font-mono mt-0.5 block truncate max-w-xl">{item.details}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {selectedItem && <RawDetailsModal item={selectedItem} config={config} onClose={() => setSelectedItem(null)} orgName={orgName} />}
    </>
  );
}

/* ─── Raw Details Modal ─── */

function RawDetailsModal({ item, config, onClose, orgName }: { item: any; config: WidgetConfig; onClose: () => void; orgName?: string }) {
  const name = item.repo || item.user || item.team || "Unknown Entity";

  let githubLink = null;
  if (item.repo && orgName) {
    githubLink = `https://github.com/${orgName}/${item.repo}`;
    if (config.type === "preset" && config.presetId === "dependabot") {
      githubLink += "/security/dependabot";
    }
  } else if (item.user) {
    githubLink = `https://github.com/${item.user}`;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-900 shrink-0 rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-info text-blue-600 dark:text-blue-400"></i>
            {name}
          </h3>
          <div className="flex items-center gap-3">
            {githubLink && (
              <a
                href={githubLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 border border-slate-200 dark:border-slate-700"
              >
                <i className="ph-fill ph-github-logo text-sm"></i>
                View in GitHub
              </a>
            )}
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto bg-slate-50 dark:bg-slate-950 flex-1 rounded-b-2xl">
          <div className="flex flex-col gap-4">
            {item.status && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">Status</span>
                <div>
                  {item.status === "pass" ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-check-circle"></i>Passing</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-rose-700 dark:text-red-400 bg-rose-50 dark:bg-red-950/50 border border-rose-200 dark:border-red-800 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-x-circle"></i>Failing</span>
                  )}
                </div>
              </div>
            )}
            {item.status === "fail" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Failure Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).replace(/"/g, "").trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-rose-50 dark:bg-red-950/50 border border-rose-200 dark:border-red-800 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-800 dark:text-rose-300 bg-rose-100 dark:bg-rose-900 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-rose-700 dark:text-red-400">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {item.status === "pass" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-2">Branch Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-900 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-emerald-700 dark:text-emerald-400">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {Object.entries(item).filter(([k]) => !["repo", "user", "team", "status", "reason"].includes(k)).map(([k, v], i) => (
              <div key={i} className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto whitespace-pre-wrap font-mono">
                  {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                </pre>
              </div>
            ))}
            {!item.status && Object.entries(item).filter(([k]) => ["reason"].includes(k)).map(([k, v], i) => (
              <div key={`r-${i}`} className="flex flex-col border-b border-slate-100 dark:border-slate-700 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 dark:text-slate-300 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-900 p-3 rounded-lg border border-slate-200 dark:border-slate-700 overflow-x-auto whitespace-pre-wrap font-mono">
                  {String(v)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Widget Details Modal (expanded from grid card) ─── */


/* ─── Widget Form Modal (Add / Edit) ─── */

function WidgetFormModal({ onClose, onSave, isSaving, initialData }: { onClose: () => void; onSave: (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => void; isSaving?: boolean; initialData?: WidgetConfig }) {
  const isEditing = !!initialData;
  const [title, setTitle] = useState(initialData?.title || "");
  const [type, setType] = useState<WidgetType>(initialData?.type || "preset");
  const [presetId, setPresetId] = useState<PresetId>((initialData?.presetId as PresetId) || "dependabot");
  // Reuses queryParam rather than adding a field, so it persists with the rest
  // of the widget without a schema change.
  const [presetSeverity, setPresetSeverity] = useState<string>(initialData?.queryParam || "any");
  const [displayType, setDisplayType] = useState<DisplayType>(initialData?.displayType || "metric");

  const [selectedQueryId, setSelectedQueryId] = useState<string>(initialData?.queryId || QUERY_OPTIONS[0].id);
  const initParam = initialData?.queryParam || "";
  const initQuery = initialData?.queryId ? QUERY_OPTIONS.find(q => q.id === initialData.queryId) : null;
  const initAdv = initialData?.queryAdvanced;
  const [paramValue, setParamValue] = useState<string>(initQuery?.useTagInput ? "" : initParam);
  const [branchTags, setBranchTags] = useState<string[]>(initQuery?.useTagInput && initParam ? initParam.split(",").map(s => s.trim()).filter(Boolean) : []);
  const [hasPendingBranch, setHasPendingBranch] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [protectionType, setProtectionType] = useState<string>(initAdv?.protectionType || "any");
  const [ruleMatchType, setRuleMatchType] = useState<string>(initAdv?.ruleMatchType || "at_least");
  const [requirePr, setRequirePr] = useState(initAdv?.requirePr || false);
  const [minApprovals, setMinApprovals] = useState(initAdv?.minApprovals ?? 1);
  const [dismissStaleReviews, setDismissStaleReviews] = useState(initAdv?.dismissStaleReviews || false);
  const [requireCodeOwnerReviews, setRequireCodeOwnerReviews] = useState(initAdv?.requireCodeOwnerReviews || false);
  const [requireConversationResolution, setRequireConversationResolution] = useState(initAdv?.requireConversationResolution || false);
  const [requireStatusChecks, setRequireStatusChecks] = useState(initAdv?.requireStatusChecks || false);
  const [strictStatusChecks, setStrictStatusChecks] = useState(initAdv?.strictStatusChecks || false);
  const [requireSignedCommits, setRequireSignedCommits] = useState(initAdv?.requireSignedCommits || false);
  const [requireLinearHistory, setRequireLinearHistory] = useState(initAdv?.requireLinearHistory || false);
  const [enforceAdmins, setEnforceAdmins] = useState(initAdv?.enforceAdmins || false);
  const [preventForcePush, setPreventForcePush] = useState(initAdv?.preventForcePush || false);
  const [preventDeletion, setPreventDeletion] = useState(initAdv?.preventDeletion || false);

  const selectedQuery = QUERY_OPTIONS.find(q => q.id === selectedQueryId);

  const handleQuerySelect = (id: string) => {
    setSelectedQueryId(id);
    const q = QUERY_OPTIONS.find(opt => opt.id === id);
    if (q?.requiresParam && q.paramDefault) setParamValue(q.paramDefault);
    else setParamValue("");
    setBranchTags([]);
  };

  const pendingBranchError = type === "query" && selectedQuery?.useTagInput && hasPendingBranch;
  const emptyBranchError = type === "query" && selectedQuery?.useTagInput && branchTags.length === 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitAttempted(true);
    if (!title.trim()) return;
    if (pendingBranchError || emptyBranchError) return;
    if (type === "query" && selectedQuery?.requiresParam && !selectedQuery?.useTagInput && !paramValue.trim()) return;

    if (type === "preset") {
      onSave({
        title, type, presetId, displayType,
        ...(presetId === "vuln-repos" && { queryParam: presetSeverity }),
      });
    } else {
      let advanced = undefined;
      if (selectedQuery?.hasAdvancedRules) {
        advanced = {
          protectionType,
          ruleMatchType,
          requirePr,
          minApprovals,
          dismissStaleReviews,
          requireCodeOwnerReviews,
          requireConversationResolution,
          requireStatusChecks,
          strictStatusChecks,
          requireSignedCommits,
          requireLinearHistory,
          enforceAdmins,
          preventForcePush,
          preventDeletion,
        };
      }
      const resolvedParam = selectedQuery?.useTagInput ? branchTags.join(", ") : paramValue.trim();
      onSave({
        title,
        type,
        queryId: selectedQueryId,
        queryParam: selectedQuery?.requiresParam ? resolvedParam : undefined,
        queryAdvanced: advanced,
        displayType,
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">{isEditing ? "Edit Widget" : "Add Dashboard Widget"}</h3>
          <button onClick={onClose} className="text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white"><i className="ph ph-x text-lg"></i></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Widget Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              placeholder="e.g. My Custom Metric"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Data Source</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as WidgetType)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="preset">Built-in Ranking Presets</option>
                <option value="query">Security Insight Query</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Display Format</label>
              <select
                value={displayType}
                onChange={(e) => setDisplayType(e.target.value as DisplayType)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
              >
                <option value="metric">Big Metric (Count)</option>
                <option value="table">List / Table</option>
              </select>
            </div>
          </div>

          <div className="p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-lg space-y-4">
            {type === "preset" ? (
              <div>
                <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Select Preset</label>
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value as PresetId)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                >
                  <option value="dependabot">Dependabot Issues Ranking</option>
                  <option value="vuln-repos">Repositories with vulnerabilities</option>
                  <option value="bypasses">Protection Rule Bypasses</option>
                </select>

                {presetId === "vuln-repos" && (
                  <div className="mt-3">
                    <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Severity</label>
                    <select
                      value={presetSeverity}
                      onChange={(e) => setPresetSeverity(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                    >
                      {SEVERITY_CHOICES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                    </select>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
                      Counts repositories, not alerts. Reads the same data as the Dependabot tab,
                      so this widget makes no extra GitHub requests.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">Select Insight Query</label>
                  <select
                    value={selectedQueryId}
                    onChange={(e) => handleQuerySelect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                  >
                    {QUERY_OPTIONS.map(q => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                </div>

                {selectedQuery?.requiresParam && (
                  <div>
                    <label className="block text-sm font-semibold text-slate-900 dark:text-white mb-1">{selectedQuery.paramLabel}</label>
                    {selectedQuery.useTagInput ? (
                      <>
                        <TagInput
                          tags={branchTags}
                          onChange={setBranchTags}
                          onPendingTextChange={setHasPendingBranch}
                          icon="ph-git-branch"
                          colorClass="blue"
                          placeholder="Type branch name and press Enter"
                        />
                        {submitAttempted && pendingBranchError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            Press Enter to confirm the branch name before saving.
                          </p>
                        )}
                        {submitAttempted && emptyBranchError && !pendingBranchError && (
                          <p className="mt-1.5 text-xs text-rose-600 flex items-center gap-1">
                            <i className="ph-bold ph-warning-circle"></i>
                            At least one branch name is required.
                          </p>
                        )}
                      </>
                    ) : (
                      <input
                        type="text"
                        value={paramValue}
                        onChange={(e) => setParamValue(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm bg-white dark:bg-slate-800 dark:text-slate-200"
                        required
                      />
                    )}
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-3 border-t border-slate-200 dark:border-slate-700 space-y-3">
                    <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Branch Rule Configuration</label>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-white mb-1">Protection Type</label>
                        <select
                          value={protectionType}
                          onChange={(e) => setProtectionType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="classic">Must use Classic Protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 dark:text-white mb-1">Rule Matching Mode</label>
                        <select
                          value={ruleMatchType}
                          onChange={(e) => setRuleMatchType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded-md text-sm outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>
                    </div>

                    {ruleMatchType !== "any" && (
                      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-3">
                        <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">Required Rules</h4>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={requirePr} onChange={e => setRequirePr(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Require Pull Request
                          </label>
                          {requirePr && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-500 dark:text-slate-400">Min. Approvals:</span>
                              <input
                                type="number" min={1} max={5}
                                value={minApprovals}
                                onChange={(e) => setMinApprovals(parseInt(e.target.value))}
                                className="w-16 rounded-md border-slate-300 dark:border-slate-600 py-1 px-2 text-xs ring-1 ring-inset ring-slate-300 dark:ring-slate-600 outline-none focus:border-blue-500 bg-white dark:bg-slate-800 dark:text-slate-200"
                              />
                            </div>
                          )}
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={dismissStaleReviews} onChange={e => setDismissStaleReviews(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Dismiss stale reviews
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventForcePush} onChange={e => setPreventForcePush(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Prevent force pushing
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventDeletion} onChange={e => setPreventDeletion(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Prevent deletion
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={enforceAdmins} onChange={e => setEnforceAdmins(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Enforce for admins
                          </label>
                        </div>

                        <details className="group/det mt-3">
                          <summary className="text-[11px] font-semibold text-blue-600 dark:text-blue-400 cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-slate-100 dark:border-slate-700">
                            <i className="ph-bold ph-caret-right text-[10px] group-open/det:rotate-90 transition-transform"></i>
                            Advanced Rules
                          </summary>
                          <div className="grid grid-cols-2 gap-y-2 gap-x-4 pt-3 mt-1 text-sm">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireCodeOwnerReviews} onChange={e => setRequireCodeOwnerReviews(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require Code Owner review
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireConversationResolution} onChange={e => setRequireConversationResolution(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require conversation resolution
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireStatusChecks} onChange={e => setRequireStatusChecks(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require status checks
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={strictStatusChecks} onChange={e => setStrictStatusChecks(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Strict status checks (up to date)
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireSignedCommits} onChange={e => setRequireSignedCommits(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require signed commits
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireLinearHistory} onChange={e => setRequireLinearHistory(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                              Require linear history
                            </label>
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200 dark:border-slate-700">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 dark:border-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 dark:hover:bg-slate-800 dark:text-slate-300 transition-colors" disabled={isSaving}>
              Cancel
            </button>
            <button type="submit" className="px-4 py-2 bg-slate-900 text-white rounded-lg text-sm font-medium hover:bg-slate-800 disabled:opacity-50 transition-colors" disabled={isSaving}>
              {isSaving ? "Saving..." : isEditing ? "Update Widget" : "Save Widget"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
