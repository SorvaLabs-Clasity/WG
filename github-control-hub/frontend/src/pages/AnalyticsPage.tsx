import React, { useState, useMemo, useEffect } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useSecurityQuery, useBlastRadiusRanking } from "../hooks/useGraph";
import { useDependencies } from "../hooks/useDependencies";
import { useRepos } from "../hooks/useRepos";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import { useWidgets, useCreateWidget, useUpdateWidget, useDeleteWidget } from "../hooks/useWidgets";
import type { WidgetConfig } from "../api/widgets";
import { TagInput } from "../components/TagInput";

type WidgetType = "preset" | "query";
type DisplayType = "metric" | "table";
type PresetId = "dependabot" | "bypasses" | "blast";

export default function AnalyticsPage() {
  const { user } = useAuth();
  const { data: widgets = [], isLoading: widgetsLoading } = useWidgets();
  const createWidget = useCreateWidget();
  const updateWidget = useUpdateWidget();
  const deleteWidgetMut = useDeleteWidget();

  const [showAddModal, setShowAddModal] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WidgetConfig | null>(null);
  const [isDashboardView, setIsDashboardView] = useState(false);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);

  useEffect(() => {
    if (!isDashboardView && widgets.length > 0 && !selectedWidgetId) {
      setSelectedWidgetId(widgets[0].id);
    }
  }, [isDashboardView, widgets, selectedWidgetId]);

  const handleAddWidget = (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => {
    createWidget.mutate(config, { onSuccess: () => setShowAddModal(false) });
  };

  const handleEditWidget = (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => {
    if (!editingWidget) return;
    updateWidget.mutate({ id: editingWidget.id, data: config }, { onSuccess: () => setEditingWidget(null) });
  };

  const removeWidget = (id: string) => {
    deleteWidgetMut.mutate(id);
    if (selectedWidgetId === id) setSelectedWidgetId(null);
  };

  return (
    <div className="bg-slate-50 text-slate-900 min-h-screen pt-14 flex flex-col">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <main className="flex-1 max-w-[1400px] w-full mx-auto px-4 sm:px-6 py-8 flex flex-col gap-0">
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
          <div className="flex items-start gap-5">
            <div className="w-14 h-14 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-lg shadow-slate-900/20 shrink-0">
              <i className="ph-fill ph-chart-bar text-2xl"></i>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-1">Analytics Dashboard</h1>
              <p className="text-slate-500 text-sm max-w-lg leading-relaxed">
                Insight into security posture, rule bypasses, and structural metrics across your GitHub organization.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0">
            <div className="bg-white rounded-lg border border-slate-200 p-1 shadow-sm inline-flex h-10 items-center">
              <button
                onClick={() => setIsDashboardView(false)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${!isDashboardView ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                <i className="ph-fill ph-list-dashes"></i>
                <span>List</span>
              </button>
              <button
                onClick={() => setIsDashboardView(true)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 ${isDashboardView ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-50'}`}
              >
                <i className="ph-fill ph-squares-four"></i>
                <span>Grid</span>
              </button>
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="group bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-lg shadow-lg hover:shadow-xl hover:-translate-y-0.5 transition-all duration-300 font-medium text-sm flex items-center gap-2"
            >
              <i className="fas fa-plus text-xs group-hover:rotate-90 transition-transform"></i>
              <span>Add Widget</span>
            </button>
          </div>
        </header>

        {widgetsLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900"></div>
          </div>
        ) : isDashboardView ? (
          /* ─── Grid View ─── */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {widgets.map(widget => (
              <WidgetCard key={widget.id} config={widget} onRemove={() => removeWidget(widget.id)} onEdit={() => setEditingWidget(widget)} />
            ))}
            {widgets.length === 0 && (
              <div className="border-2 border-dashed border-slate-200 rounded-2xl h-[340px] flex flex-col items-center justify-center text-center p-8 group hover:border-slate-300 transition-colors col-span-full">
                <div className="w-16 h-16 rounded-full bg-slate-50 text-slate-300 flex items-center justify-center mb-4 group-hover:text-slate-400 group-hover:bg-slate-100 transition-colors">
                  <i className="ph-fill ph-chart-pie-slice text-3xl"></i>
                </div>
                <h3 className="text-slate-900 font-semibold mb-1">No widgets added yet</h3>
                <p className="text-slate-500 text-sm mb-4">Track coverage, throughput, or custom data points.</p>
                <button onClick={() => setShowAddModal(true)} className="text-blue-600 text-sm font-bold hover:underline">
                  + Create Widget
                </button>
              </div>
            )}
            {widgets.length > 0 && (
              <div className="border-2 border-dashed border-slate-200 rounded-2xl h-[340px] flex flex-col items-center justify-center text-center p-8 group hover:border-slate-300 transition-colors">
                <div className="w-16 h-16 rounded-full bg-slate-50 text-slate-300 flex items-center justify-center mb-4 group-hover:text-slate-400 group-hover:bg-slate-100 transition-colors">
                  <i className="ph-fill ph-chart-pie-slice text-3xl"></i>
                </div>
                <h3 className="text-slate-900 font-semibold mb-1">Add Another Metric</h3>
                <p className="text-slate-500 text-sm mb-4">Track coverage, throughput, or custom data points.</p>
                <button onClick={() => setShowAddModal(true)} className="text-blue-600 text-sm font-bold hover:underline">
                  + Create Widget
                </button>
              </div>
            )}
          </div>
        ) : (
          /* ─── List View ─── */
          <div className="flex flex-col lg:flex-row gap-6 h-[750px]">
            {/* Left panel: widget sidebar */}
            <aside className="w-full lg:w-1/3 bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_-2px_rgba(0,0,0,0.05)] flex flex-col overflow-hidden">
              <div className="bg-slate-50 px-5 py-3 border-b border-slate-100 flex justify-between items-center sticky top-0 z-10">
                <span className="font-semibold text-slate-800 text-sm tracking-wide uppercase opacity-70">Your Analytics</span>
                <span className="text-xs font-mono text-slate-400">{widgets.length} Active</span>
              </div>
              <div className="overflow-y-auto flex-1 divide-y divide-slate-100">
                {widgets.map(w => (
                  <div
                    key={w.id}
                    onClick={() => setSelectedWidgetId(w.id)}
                    className={`group relative px-5 py-4 cursor-pointer hover:bg-slate-50 transition-colors border-l-[3px] ${selectedWidgetId === w.id ? 'bg-blue-50/40 border-blue-600' : 'border-transparent'}`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className={`font-semibold text-sm mb-1 ${selectedWidgetId === w.id ? 'text-slate-900' : 'text-slate-700 group-hover:text-slate-900'}`}>
                          {w.title}
                        </h3>
                        <div className={`flex items-center gap-1.5 text-xs font-medium ${selectedWidgetId === w.id ? 'text-blue-600' : 'text-slate-400'}`}>
                          {w.type === 'preset' ? (
                            <>
                              <i className="fas fa-wrench text-[10px]"></i>
                              <span>Built-in Preset</span>
                            </>
                          ) : (
                            <>
                              <i className="ph-bold ph-magnifying-glass"></i>
                              <span>Custom Query</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                        <button onClick={(e) => { e.stopPropagation(); setEditingWidget(w); }} className="text-slate-400 hover:text-blue-600">
                          <i className="ph-bold ph-pencil-simple"></i>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); removeWidget(w.id); }} className="text-slate-400 hover:text-rose-600">
                          <i className="ph-bold ph-trash"></i>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {widgets.length === 0 && (
                  <div className="p-8 text-center text-slate-400 text-sm">No analytics added yet.</div>
                )}
              </div>
            </aside>

            {/* Right panel: selected widget detail */}
            <section className="w-full lg:w-2/3 bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_-2px_rgba(0,0,0,0.05)] flex flex-col h-full overflow-hidden">
              {selectedWidgetId ? (
                <WidgetDetailsInline
                  config={widgets.find(w => w.id === selectedWidgetId)!}
                  onEdit={() => setEditingWidget(widgets.find(w => w.id === selectedWidgetId)!)}
                />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-slate-400">
                  <i className="ph-light ph-chart-polar text-5xl mb-3 opacity-50"></i>
                  <p className="text-sm">Select an analytic from the list to view details</p>
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {showAddModal && <WidgetFormModal onClose={() => setShowAddModal(false)} onSave={handleAddWidget} isSaving={createWidget.isPending} />}
      {editingWidget && <WidgetFormModal onClose={() => setEditingWidget(null)} onSave={handleEditWidget} isSaving={updateWidget.isPending} initialData={editingWidget} />}
    </div>
  );
}

/* ─── Data Hook ─── */

function useWidgetData(config: WidgetConfig) {
  const { data: depsData, isLoading: depsLoading } = useDependencies();
  const { data: blastData, isLoading: blastLoading } = useBlastRadiusRanking();
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
      } else if (config.presetId === "bypasses") {
        loading = bypassLoading;
        rawItems = bypassData || [];
      } else if (config.presetId === "blast") {
        loading = blastLoading;
        rawItems = blastData || [];
      }
    } else {
      loading = queryLoading;
      rawItems = queryData || [];
    }

    return { items: rawItems, isLoading: loading };
  }, [config, depsData, depsLoading, blastData, blastLoading, bypassData, bypassLoading, queryData, queryLoading]);

  const isRepoQuery = config.type === "preset" || (config.type === "query" && config.queryId?.startsWith("repos-"));
  const total = isRepoQuery && repos ? repos.length : null;

  return { items, isLoading, total };
}

/* ─── Widget Card (Grid View) ─── */

function WidgetCard({ config, onRemove, onEdit }: { config: WidgetConfig; onRemove: () => void; onEdit: () => void }) {
  const { items, isLoading, total } = useWidgetData(config);
  const [showDetails, setShowDetails] = useState(false);

  const widgetIcon = useMemo(() => {
    if (config.type === "preset") {
      if (config.presetId === "dependabot") return { cls: "ph-fill ph-bug text-rose-500", color: "rose" };
      if (config.presetId === "bypasses") return { cls: "ph-fill ph-shield-warning text-amber-500", color: "amber" };
      if (config.presetId === "blast") return { cls: "ph-fill ph-target text-orange-500", color: "orange" };
    }
    const hasStatus = items.some((i: any) => i.status);
    if (hasStatus) {
      const allPass = items.every((i: any) => i.status === "pass");
      if (allPass) return { cls: "ph-fill ph-check-circle text-emerald-500", color: "emerald" };
      return { cls: "ph-fill ph-warning-octagon text-rose-500", color: "rose" };
    }
    return { cls: "ph-fill ph-magnifying-glass text-blue-500", color: "blue" };
  }, [config, items]);

  return (
    <>
      <div className="bg-white rounded-2xl border border-slate-100 shadow-[0_4px_20px_-2px_rgba(0,0,0,0.05)] h-[340px] flex flex-col group hover:-translate-y-1 hover:shadow-lg transition-all duration-300">
        {/* Card header */}
        <div className="bg-gradient-to-r from-slate-50 to-white px-5 py-3 border-b border-slate-100 flex justify-between items-center rounded-t-2xl">
          <span className="font-semibold text-slate-800 text-sm truncate flex items-center gap-2">
            <i className={widgetIcon.cls}></i>
            {config.title}
          </span>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
            <button onClick={() => setShowDetails(true)} className="text-slate-400 hover:text-slate-900" title="Expand">
              <i className="ph-bold ph-arrows-out-simple"></i>
            </button>
            <button onClick={onEdit} className="text-slate-400 hover:text-blue-600" title="Edit">
              <i className="ph-bold ph-pencil-simple"></i>
            </button>
            <button onClick={onRemove} className="text-slate-400 hover:text-rose-600" title="Remove">
              <i className="ph-bold ph-trash"></i>
            </button>
          </div>
        </div>

        {/* Card body */}
        <div className="flex-1 relative overflow-hidden">
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900"></div>
            </div>
          ) : config.displayType === "metric" ? (
            <MetricCardBody items={items} total={total} config={config} onExpand={() => setShowDetails(true)} />
          ) : (
            <TableCardBody items={items} config={config} onExpand={() => setShowDetails(true)} />
          )}
        </div>
      </div>

      {showDetails && <WidgetDetailsModal config={config} items={items} onClose={() => setShowDetails(false)} />}
    </>
  );
}

function MetricCardBody({ items, total, config, onExpand }: { items: any[]; total: number | null; config: WidgetConfig; onExpand: () => void }) {
  const hasStatus = items.some((i: any) => i.status);
  const passCount = hasStatus ? items.filter((i: any) => i.status === "pass").length : items.length;
  const denominator = hasStatus ? items.length : total;
  const passRate = denominator ? Math.round((passCount / denominator) * 100) : null;

  const isGood = passRate !== null && passRate >= 80;
  const isBad = passRate !== null && passRate < 60;

  return (
    <div
      className={`flex-1 h-full flex flex-col items-center justify-center p-6 cursor-pointer relative overflow-hidden ${isBad ? 'bg-gradient-to-b from-white to-rose-50/30' : isGood ? 'bg-gradient-to-b from-white to-emerald-50/30' : ''}`}
      onClick={onExpand}
    >
      <div className="absolute inset-0 bg-blue-50/20 translate-y-20 rounded-full blur-3xl w-2/3 mx-auto"></div>
      <span className={`text-7xl font-light font-mono tracking-tighter z-10 ${isBad ? 'text-rose-600' : isGood ? 'text-slate-900' : 'text-blue-600'}`}>
        {passCount}
        {denominator !== null && <span className="text-2xl text-slate-400">/ {denominator}</span>}
      </span>
      <div className="mt-4 flex flex-col items-center z-10">
        {passRate !== null && (
          <>
            <span className="text-slate-400 text-sm font-mono mb-2">{passRate}% {hasStatus ? 'passing' : 'match'}</span>
            <span className={`inline-flex px-3 py-1 rounded-full text-xs font-bold font-mono ${
              passRate === 100 ? 'bg-emerald-100 text-emerald-800' :
              passRate >= 80 ? 'bg-emerald-100 text-emerald-800' :
              passRate >= 60 ? 'bg-amber-100 text-amber-800' :
              'bg-rose-100 text-rose-800'
            }`}>
              {passRate === 100 ? 'COMPLIANT' : passRate >= 80 ? 'GOOD' : passRate >= 60 ? 'WARNING' : 'CRITICAL'}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function TableCardBody({ items, config, onExpand }: { items: any[]; config: WidgetConfig; onExpand: () => void }) {
  if (items.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-slate-400 italic cursor-pointer hover:bg-slate-50 rounded" onClick={onExpand}>
        No data to display
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left">
          <tbody className="divide-y divide-slate-50">
            {items.slice(0, 5).map((item: any, idx: number) => {
              const name = item.repo || item.user || item.team || "Unknown";
              const val = config.presetId === "dependabot" ? item.total : config.presetId === "bypasses" ? item.bypasses : config.presetId === "blast" ? item.score : "";
              return (
                <tr key={idx} className="hover:bg-slate-50 cursor-pointer" onClick={onExpand}>
                  <td className="px-5 py-3 text-sm font-medium text-slate-700 flex items-center gap-2">
                    {item.status === "pass" && <i className="ph-bold ph-check-circle text-emerald-500 text-xs shrink-0"></i>}
                    {item.status === "fail" && <i className="ph-bold ph-x-circle text-rose-500 text-xs shrink-0"></i>}
                    <span className="truncate">{name}</span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {val !== "" && (
                      <span className="bg-slate-100 text-slate-600 text-xs font-mono px-2 py-0.5 rounded border border-slate-200">
                        {val}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {items.length > 5 && (
        <button
          onClick={onExpand}
          className="w-full py-3 text-center text-sm font-medium text-blue-600 border-t border-slate-100 hover:bg-blue-50 transition-colors"
        >
          View all {items.length} results
        </button>
      )}
    </div>
  );
}

/* ─── Widget Details Inline (List View right panel) ─── */

function WidgetDetailsInline({ config, onEdit }: { config: WidgetConfig; onEdit: () => void }) {
  const { items, isLoading } = useWidgetData(config);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-slate-900"></div>
      </div>
    );
  }

  const hasStatus = items.some((i: any) => i.status);
  const passCount = hasStatus ? items.filter((i: any) => i.status === "pass").length : 0;
  const failCount = hasStatus ? items.filter((i: any) => i.status === "fail").length : 0;

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative">
      {/* Detail Header */}
      <div className="p-6 border-b border-slate-100 bg-white">
        <div className="flex justify-between items-start mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
              <i className="ph-fill ph-chart-bar text-xl"></i>
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-900">{config.title}</h2>
              <p className="text-slate-500 text-xs mt-0.5">
                {config.type === "preset"
                  ? `Built-in preset: ${config.presetId}`
                  : `Custom query: ${QUERY_OPTIONS.find(q => q.id === config.queryId)?.label || config.queryId}`}
              </p>
            </div>
          </div>
          <button onClick={onEdit} className="text-slate-400 hover:text-slate-800 p-2 hover:bg-slate-50 rounded-lg transition-colors">
            <i className="ph-bold ph-pencil-simple text-lg"></i>
          </button>
        </div>

        {/* Pill Summary */}
        <div className="flex flex-wrap gap-3">
          {hasStatus && (
            <>
              <div className="px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-xs font-bold flex items-center gap-1.5 pointer-events-none">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
                {passCount} Passing
              </div>
              <div className="px-3 py-1 bg-rose-50 text-rose-700 border border-rose-200 rounded-full text-xs font-bold flex items-center gap-1.5 pointer-events-none">
                <span className="w-1.5 h-1.5 bg-rose-500 rounded-full"></span>
                {failCount} Failing
              </div>
            </>
          )}
          <div className="px-3 py-1 bg-slate-100 text-slate-600 border border-slate-200 rounded-full text-xs font-bold font-mono">
            Total: {items.length}
          </div>
        </div>
      </div>

      {/* Detail Table */}
      <div className="flex-1 overflow-auto">
        <WidgetDataTable config={config} items={items} />
      </div>
    </div>
  );
}

/* ─── Widget Data Table ─── */

function WidgetDataTable({ config, items }: { config: WidgetConfig; items: any[] }) {
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  if (items.length === 0) {
    return (
      <div className="p-12 text-center text-slate-500">
        <i className="ph-fill ph-check-circle text-4xl text-emerald-500 mb-3 block opacity-80"></i>
        No data matches this query or preset.
      </div>
    );
  }

  const hasStatus = items.some((i: any) => i.status);

  return (
    <>
      <table className="w-full text-left border-collapse">
        <thead className="bg-slate-50 sticky top-0 z-10 text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-200">
          <tr>
            <th className="px-6 py-3 w-16">#</th>
            <th className="px-6 py-3">Entity</th>

            {config.type === "preset" && config.presetId === "dependabot" && (
              <>
                <th className="px-6 py-3 text-center text-rose-600">Critical</th>
                <th className="px-6 py-3 text-center text-orange-500">High</th>
                <th className="px-6 py-3 text-center text-amber-600">Medium</th>
                <th className="px-6 py-3 text-center text-slate-500">Low</th>
                <th className="px-6 py-3 text-center">Total</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "bypasses" && (
              <>
                <th className="px-6 py-3">Bypasses</th>
                <th className="px-6 py-3 w-full">Reason</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "blast" && (
              <>
                <th className="px-6 py-3">Risk Level</th>
                <th className="px-6 py-3 text-center">Score</th>
              </>
            )}
            {config.type === "query" && hasStatus && <th className="px-6 py-3 text-center w-[80px]">Status</th>}
            {config.type === "query" && <th className="px-6 py-3 w-full">Details</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 text-sm">
          {items.map((item: any, idx: number) => {
            const name = item.repo || item.user || item.team || "Unknown";
            return (
              <tr
                key={idx}
                className="group hover:bg-slate-50 transition-colors cursor-pointer"
                style={idx % 2 === 1 ? { backgroundColor: "#f8fafc" } : undefined}
                onClick={() => setSelectedItem(item)}
              >
                <td className="px-6 py-4 font-mono text-slate-400 text-xs">{String(idx + 1).padStart(3, "0")}</td>
                <td className="px-6 py-4">
                  <div className="font-bold text-slate-800">{name}</div>
                  {config.type === "query" && (
                    <div className="text-xs text-slate-400 font-mono">{item.repo ? "repository" : item.user ? "user" : item.team ? "team" : "unknown"}</div>
                  )}
                </td>

                {config.type === "preset" && config.presetId === "dependabot" && (
                  <>
                    <td className="px-6 py-4 text-center font-mono font-medium text-rose-600">{item.critical || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-orange-500">{item.high || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-amber-600">{item.medium || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-medium text-slate-500">{item.low || "-"}</td>
                    <td className="px-6 py-4 text-center font-mono font-bold">{item.total}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "bypasses" && (
                  <>
                    <td className="px-6 py-4 font-mono font-bold text-rose-600">{item.bypasses}</td>
                    <td className="px-6 py-4 text-sm text-slate-500 truncate">{item.reason}</td>
                  </>
                )}
                {config.type === "preset" && config.presetId === "blast" && (
                  <>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border ${
                        item.riskLevel === "CRITICAL" ? "bg-rose-50 text-rose-700 border-rose-200" :
                        item.riskLevel === "HIGH" ? "bg-orange-50 text-orange-700 border-orange-200" :
                        item.riskLevel === "MEDIUM" ? "bg-amber-50 text-amber-700 border-amber-200" :
                        "bg-emerald-50 text-emerald-700 border-emerald-200"
                      }`}>
                        {item.riskLevel === "CRITICAL" && <i className="fas fa-times-circle"></i>}
                        {item.riskLevel === "HIGH" && <i className="fas fa-exclamation-circle"></i>}
                        {item.riskLevel === "MEDIUM" && <i className="fas fa-exclamation-triangle"></i>}
                        {item.riskLevel === "LOW" && <i className="fas fa-check-circle"></i>}
                        {item.riskLevel}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-center font-bold">{item.score}</td>
                  </>
                )}

                {config.type === "query" && hasStatus && (
                  <td className="px-6 py-4 text-center">
                    {item.status === "pass" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
                        <i className="fas fa-check-circle"></i> Pass
                      </span>
                    ) : item.status === "fail" ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
                        <i className="fas fa-times-circle"></i> Fail
                      </span>
                    ) : null}
                  </td>
                )}
                {config.type === "query" && (
                  <td className="px-6 py-4 text-sm">
                    <span className={`block truncate max-w-xl ${item.status === "fail" ? "text-rose-700" : "text-slate-800"}`}>{item.reason}</span>
                    {item.details && <span className="text-xs text-slate-500 font-mono mt-0.5 block truncate max-w-xl">{item.details}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {selectedItem && <RawDetailsModal item={selectedItem} config={config} onClose={() => setSelectedItem(null)} />}
    </>
  );
}

/* ─── Raw Details Modal ─── */

function RawDetailsModal({ item, config, onClose }: { item: any; config: WidgetConfig; onClose: () => void }) {
  const { user } = useAuth();
  const name = item.repo || item.user || item.team || "Unknown Entity";

  let githubLink = null;
  if (item.repo) {
    githubLink = `https://github.com/${user?.login || "org"}/${item.repo}`;
    if (config.type === "preset" && config.presetId === "dependabot") {
      githubLink += "/security/dependabot";
    }
  } else if (item.user) {
    githubLink = `https://github.com/${item.user}`;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-white shrink-0 rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-info text-blue-600"></i>
            {name}
          </h3>
          <div className="flex items-center gap-3">
            {githubLink && (
              <a
                href={githubLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 border border-slate-200"
              >
                <i className="ph-fill ph-github-logo text-sm"></i>
                View in GitHub
              </a>
            )}
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto bg-slate-50 flex-1 rounded-b-2xl">
          <div className="flex flex-col gap-4">
            {item.status && (
              <div className="flex flex-col border-b border-slate-100 pb-3">
                <span className="text-sm font-bold text-slate-700 mb-1">Status</span>
                <div>
                  {item.status === "pass" ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-check-circle"></i>Passing</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-rose-700 bg-rose-50 border border-rose-200 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-x-circle"></i>Failing</span>
                  )}
                </div>
              </div>
            )}
            {item.status === "fail" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 pb-3">
                <span className="text-sm font-bold text-slate-700 mb-2">Failure Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).replace(/"/g, "").trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-rose-50 border border-rose-200 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-rose-800 bg-rose-100 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-rose-700">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {item.status === "pass" && item.reason && (
              <div className="flex flex-col border-b border-slate-100 pb-3">
                <span className="text-sm font-bold text-slate-700 mb-2">Branch Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-emerald-700">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {Object.entries(item).filter(([k]) => !["repo", "user", "team", "status", "reason"].includes(k)).map(([k, v], i) => (
              <div key={i} className="flex flex-col border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 bg-white p-3 rounded-lg border border-slate-200 overflow-x-auto whitespace-pre-wrap font-mono">
                  {typeof v === "object" ? JSON.stringify(v, null, 2) : String(v)}
                </pre>
              </div>
            ))}
            {!item.status && Object.entries(item).filter(([k]) => ["reason"].includes(k)).map(([k, v], i) => (
              <div key={`r-${i}`} className="flex flex-col border-b border-slate-100 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-slate-700 mb-1">{k}</span>
                <pre className="text-sm text-slate-800 bg-white p-3 rounded-lg border border-slate-200 overflow-x-auto whitespace-pre-wrap font-mono">
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

function WidgetDetailsModal({ config, items, onClose }: { config: WidgetConfig; items: any[]; onClose: () => void }) {
  const hasStatus = items.some((i: any) => i.status);
  const passCount = hasStatus ? items.filter((i: any) => i.status === "pass").length : 0;
  const failCount = hasStatus ? items.filter((i: any) => i.status === "fail").length : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-4xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-white shrink-0 rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-chart-bar text-blue-600"></i>
            {config.title}
          </h3>
          <div className="flex items-center gap-3">
            {hasStatus && (
              <>
                <div className="px-3 py-1 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-full text-xs font-bold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
                  {passCount} Pass
                </div>
                <div className="px-3 py-1 bg-rose-50 text-rose-700 border border-rose-200 rounded-full text-xs font-bold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 bg-rose-500 rounded-full"></span>
                  {failCount} Fail
                </div>
              </>
            )}
            <div className="px-3 py-1 bg-slate-100 text-slate-600 border border-slate-200 rounded-full text-xs font-bold font-mono">
              {items.length} Total
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>

        <div className="p-0 overflow-y-auto bg-slate-50 flex-1 relative rounded-b-2xl">
          <WidgetDataTable config={config} items={items} />
        </div>
      </div>
    </div>
  );
}

/* ─── Widget Form Modal (Add / Edit) ─── */

function WidgetFormModal({ onClose, onSave, isSaving, initialData }: { onClose: () => void; onSave: (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => void; isSaving?: boolean; initialData?: WidgetConfig }) {
  const isEditing = !!initialData;
  const [title, setTitle] = useState(initialData?.title || "");
  const [type, setType] = useState<WidgetType>(initialData?.type || "preset");
  const [presetId, setPresetId] = useState<PresetId>((initialData?.presetId as PresetId) || "dependabot");
  const [displayType, setDisplayType] = useState<DisplayType>(initialData?.displayType || "metric");

  const [selectedQueryId, setSelectedQueryId] = useState<string>(initialData?.queryId || QUERY_OPTIONS[0].id);
  const initParam = initialData?.queryParam || "";
  const initQuery = initialData?.queryId ? QUERY_OPTIONS.find(q => q.id === initialData.queryId) : null;
  const initAdv = initialData?.queryAdvanced;
  const [paramValue, setParamValue] = useState<string>(initQuery?.useTagInput ? "" : initParam);
  const [branchTags, setBranchTags] = useState<string[]>(initQuery?.useTagInput && initParam ? initParam.split(",").map(s => s.trim()).filter(Boolean) : []);
  const [hasPendingBranch, setHasPendingBranch] = useState(false);
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    if (type === "query" && selectedQuery?.useTagInput && (branchTags.length === 0 || hasPendingBranch)) return;
    if (type === "query" && selectedQuery?.requiresParam && !selectedQuery?.useTagInput && !paramValue.trim()) return;

    if (type === "preset") {
      onSave({ title, type, presetId, displayType });
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
      <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between rounded-t-2xl">
          <h3 className="text-lg font-bold text-slate-900">{isEditing ? "Edit Widget" : "Add Dashboard Widget"}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-900"><i className="ph ph-x text-lg"></i></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-slate-900 mb-1">Widget Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              placeholder="e.g. My Custom Metric"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-900 mb-1">Data Source</label>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as WidgetType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              >
                <option value="preset">Built-in Ranking Presets</option>
                <option value="query">Security Insight Query</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-900 mb-1">Display Format</label>
              <select
                value={displayType}
                onChange={(e) => setDisplayType(e.target.value as DisplayType)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
              >
                <option value="metric">Big Metric (Count)</option>
                <option value="table">List / Table</option>
              </select>
            </div>
          </div>

          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
            {type === "preset" ? (
              <div>
                <label className="block text-sm font-semibold text-slate-900 mb-1">Select Preset</label>
                <select
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value as PresetId)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                >
                  <option value="dependabot">Dependabot Issues Ranking</option>
                  <option value="bypasses">Protection Rule Bypasses</option>
                  <option value="blast">Blast Radius Risk</option>
                </select>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-semibold text-slate-900 mb-1">Select Insight Query</label>
                  <select
                    value={selectedQueryId}
                    onChange={(e) => handleQuerySelect(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                  >
                    {QUERY_OPTIONS.map(q => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                </div>

                {selectedQuery?.requiresParam && (
                  <div>
                    <label className="block text-sm font-semibold text-slate-900 mb-1">{selectedQuery.paramLabel}</label>
                    {selectedQuery.useTagInput ? (
                      <TagInput
                        tags={branchTags}
                        onChange={setBranchTags}
                        onPendingTextChange={setHasPendingBranch}
                        icon="ph-git-branch"
                        colorClass="blue"
                        placeholder="Type branch name and press Enter"
                      />
                    ) : (
                      <input
                        type="text"
                        value={paramValue}
                        onChange={(e) => setParamValue(e.target.value)}
                        className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        required
                      />
                    )}
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-3 border-t border-slate-200 space-y-3">
                    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Branch Rule Configuration</label>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 mb-1">Protection Type</label>
                        <select
                          value={protectionType}
                          onChange={(e) => setProtectionType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm outline-none focus:border-blue-500"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="classic">Must use Classic Protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-900 mb-1">Rule Matching Mode</label>
                        <select
                          value={ruleMatchType}
                          onChange={(e) => setRuleMatchType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm outline-none focus:border-blue-500"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>
                    </div>

                    {ruleMatchType !== "any" && (
                      <div className="bg-white border border-slate-200 rounded-lg p-3">
                        <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Required Rules</h4>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={requirePr} onChange={e => setRequirePr(e.target.checked)} className="rounded text-blue-600 focus:ring-blue-500" />
                            Require Pull Request
                          </label>
                          {requirePr && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-slate-500">Min. Approvals:</span>
                              <input
                                type="number" min={1} max={5}
                                value={minApprovals}
                                onChange={(e) => setMinApprovals(parseInt(e.target.value))}
                                className="w-16 rounded-md border-slate-300 py-1 px-2 text-xs ring-1 ring-inset ring-slate-300 outline-none focus:border-blue-500"
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
                          <summary className="text-[11px] font-semibold text-blue-600 cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-slate-100">
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

          <div className="flex justify-end gap-3 pt-4 border-t border-slate-200">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors" disabled={isSaving}>
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
