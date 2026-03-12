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
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14 flex flex-col">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 max-w-[1400px] w-full mx-auto p-6 flex flex-col gap-6 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase flex items-center gap-3 mb-1">
              <i className="ph-fill ph-squares-four text-gh-blue"></i>
              Analytics Dashboard
            </h1>
            <p className="text-gray-500 text-sm">
              Customizable widgets for tracking security posture, rule bypasses, and structural metrics.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="bg-gray-100 p-1 rounded-lg flex items-center">
              <button 
                onClick={() => setIsDashboardView(false)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${!isDashboardView ? 'bg-white shadow-sm text-gh-textBase' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <i className="ph-fill ph-list-dashes mr-2"></i>List View
              </button>
              <button 
                onClick={() => setIsDashboardView(true)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${isDashboardView ? 'bg-white shadow-sm text-gh-textBase' : 'text-gray-500 hover:text-gray-700'}`}
              >
                <i className="ph-fill ph-squares-four mr-2"></i>Dashboard
              </button>
            </div>
            <button 
              onClick={() => setShowAddModal(true)}
              className="bg-gh-blue hover:bg-gh-blueHover text-white px-4 py-2 rounded-md text-sm font-semibold shadow-sm transition-colors flex items-center justify-center gap-2"
            >
              <i className="fa-solid fa-plus text-xs"></i>
              Add Widget
            </button>
          </div>
        </div>

        {widgetsLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
          </div>
        ) : isDashboardView ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 grid-flow-dense">
            {widgets.map(widget => (
              <WidgetCard key={widget.id} config={widget} onRemove={() => removeWidget(widget.id)} onEdit={() => setEditingWidget(widget)} />
            ))}
            {widgets.length === 0 && (
              <div className="col-span-full text-center py-16 text-gray-400 border-2 border-dashed border-gray-300 rounded-xl bg-gray-50">
                <i className="ph-light ph-chart-polar text-5xl mb-3 block opacity-50"></i>
                <p className="font-medium text-gray-500">No widgets added yet.</p>
                <p className="text-sm mt-1 mb-4">Click "Add Widget" to create your first metric, table, or chart.</p>
                <button 
                  onClick={() => setShowAddModal(true)}
                  className="bg-white border border-gray-300 hover:bg-gray-50 text-gh-textBase px-4 py-2 rounded-md text-sm font-semibold shadow-sm transition-colors"
                >
                  Add Widget
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col md:flex-row gap-4 md:gap-6 h-[calc(100vh-140px)] md:h-[calc(100vh-200px)] min-h-[500px]">
            <div className="w-full md:w-1/3 h-1/2 md:h-full bg-white border border-gh-border rounded-xl shadow-sm overflow-y-auto flex flex-col shrink-0">
              <div className="px-5 py-4 border-b border-gh-border bg-gray-50 font-semibold sticky top-0 z-10">Your Analytics</div>
              <div className="divide-y divide-gh-border flex-1">
                {widgets.map(w => (
                  <div
                    key={w.id}
                    onClick={() => setSelectedWidgetId(w.id)}
                    className={`w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors cursor-pointer group/item ${selectedWidgetId === w.id ? 'bg-blue-50/50 border-l-4 border-l-gh-blue' : 'border-l-4 border-l-transparent'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className={`font-semibold text-sm ${selectedWidgetId === w.id ? 'text-gh-blue' : 'text-gh-textBase'}`}>{w.title}</div>
                      <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                        <button onClick={(e) => { e.stopPropagation(); setEditingWidget(w); }} className="text-gray-400 hover:text-gh-blue p-1 rounded" title="Edit">
                          <i className="ph-bold ph-pencil-simple text-xs"></i>
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); removeWidget(w.id); }} className="text-gray-400 hover:text-red-500 p-1 rounded" title="Delete">
                          <i className="ph-bold ph-trash text-xs"></i>
                        </button>
                      </div>
                    </div>
                    <div className="text-xs text-gray-500 mt-1.5 flex items-center gap-1.5">
                      <i className={`ph-fill ${w.type === 'preset' ? 'ph-star text-yellow-500' : 'ph-magnifying-glass text-blue-500'}`}></i>
                      {w.type === 'preset' ? 'Built-in Preset' : 'Custom Query'}
                    </div>
                  </div>
                ))}
                {widgets.length === 0 && (
                  <div className="p-8 text-center text-gray-400 text-sm">No analytics added yet.</div>
                )}
              </div>
            </div>
            <div className="flex-1 bg-white border border-gh-border rounded-xl shadow-sm overflow-hidden flex flex-col relative">
              {selectedWidgetId ? (
                <WidgetDetailsInline config={widgets.find(w => w.id === selectedWidgetId)!} onEdit={() => setEditingWidget(widgets.find(w => w.id === selectedWidgetId)!)} />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
                  <i className="ph-light ph-chart-polar text-5xl mb-3 opacity-50"></i>
                  <p>Select an analytic from the list to view details</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {showAddModal && <WidgetFormModal onClose={() => setShowAddModal(false)} onSave={handleAddWidget} isSaving={createWidget.isPending} />}
      {editingWidget && <WidgetFormModal onClose={() => setEditingWidget(null)} onSave={handleEditWidget} isSaving={updateWidget.isPending} initialData={editingWidget} />}
    </div>
  );
}

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
        rawItems = Array.from(map.values()).sort((a,b) => b.critical !== a.critical ? b.critical - a.critical : b.high !== a.high ? b.high - a.high : b.total - a.total);
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

function WidgetCard({ config, onRemove, onEdit }: { config: WidgetConfig, onRemove: () => void, onEdit: () => void }) {
  const { items, isLoading, total } = useWidgetData(config);
  const [showDetails, setShowDetails] = useState(false);

  return (
    <>
      <div className="bg-white rounded-xl border border-gh-border shadow-sm flex flex-col overflow-hidden group h-[340px]">
        <div className="px-5 py-3 border-b border-gh-border bg-gray-50 flex items-center justify-between shrink-0">
          <h3 className="font-semibold text-gh-textBase truncate pr-2" title={config.title}>{config.title}</h3>
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button 
              onClick={() => setShowDetails(true)} 
              className="text-gray-400 hover:text-gh-blue p-1 rounded transition-colors"
              title="View Details"
            >
              <i className="ph-bold ph-arrows-out-simple"></i>
            </button>
            <button 
              onClick={onEdit} 
              className="text-gray-400 hover:text-gh-blue p-1 rounded transition-colors"
              title="Edit Widget"
            >
              <i className="ph-bold ph-pencil-simple text-xs"></i>
            </button>
            <button 
              onClick={onRemove} 
              className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors"
              title="Remove Widget"
            >
              <i className="fa-solid fa-trash-can text-xs"></i>
            </button>
          </div>
        </div>

        <div className="flex-1 relative bg-white overflow-hidden p-4">
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
            </div>
          ) : (
            <div className="h-full flex flex-col group/content">
              {config.displayType === "metric" && (() => {
                const hasStatus = items.some((i: any) => i.status);
                const passCount = hasStatus ? items.filter((i: any) => i.status === "pass").length : items.length;
                const denominator = hasStatus ? items.length : total;
                const passRate = denominator ? Math.round((passCount / denominator) * 100) : null;
                return (
                  <div 
                    className="flex-1 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 rounded-lg transition-colors" 
                    onClick={() => setShowDetails(true)}
                  >
                    <div className="text-6xl font-light text-gh-blue mb-2">
                      {passCount} {denominator !== null && <span className="text-3xl text-gray-400 font-normal">/ {denominator}</span>}
                    </div>
                    {passRate !== null && (
                      <div className={`text-sm font-bold ${passRate === 100 ? 'text-green-600' : passRate >= 80 ? 'text-yellow-600' : 'text-red-600'}`}>
                        {passRate}% {hasStatus ? 'passing' : 'match'}
                      </div>
                    )}
                    <div className="text-xs text-gh-blue font-semibold mt-4 flex items-center gap-1 opacity-0 group-hover/content:opacity-100 transition-opacity">
                      View Details <i className="ph-bold ph-arrow-right"></i>
                    </div>
                  </div>
                );
              })()}

              {config.displayType === "table" && (
                <div className="flex-1 overflow-hidden relative">
                  {items.length === 0 ? (
                    <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400 italic cursor-pointer hover:bg-gray-50 rounded" onClick={() => setShowDetails(true)}>No data to display</div>
                  ) : (
                    <div className="h-full overflow-hidden flex flex-col">
                      <div className="space-y-2 flex-1">
                        {items.slice(0, 5).map((item: any, idx: number) => {
                          const name = item.repo || item.user || item.team || "Unknown";
                          const val = config.presetId === 'dependabot' ? item.total : config.presetId === 'bypasses' ? item.bypasses : config.presetId === 'blast' ? item.score : '';
                          return (
                            <div key={idx} className="flex items-center justify-between text-sm py-1.5 px-2 hover:bg-gray-50 rounded border-b border-gray-100 last:border-0 cursor-pointer" onClick={() => setShowDetails(true)}>
                              <span className="font-medium text-gh-textBase truncate mr-3 flex items-center gap-1.5">
                                {item.status === "pass" && <i className="ph-bold ph-check-circle text-green-500 text-xs shrink-0"></i>}
                                {item.status === "fail" && <i className="ph-bold ph-x-circle text-red-500 text-xs shrink-0"></i>}
                                {name}
                              </span>
                              {val !== '' && <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded text-gray-600 font-semibold">{val}</span>}
                            </div>
                          );
                        })}
                      </div>
                      {items.length > 5 && (
                        <button 
                          onClick={() => setShowDetails(true)}
                          className="w-full mt-2 py-2 text-xs font-semibold text-gh-blue hover:bg-blue-50 rounded transition-colors text-center border border-transparent hover:border-blue-100"
                        >
                          View all {items.length} results
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showDetails && (
        <WidgetDetailsModal config={config} items={items} onClose={() => setShowDetails(false)} />
      )}
    </>
  );
}

function WidgetDetailsInline({ config, onEdit }: { config: WidgetConfig, onEdit: () => void }) {
  const { items, isLoading } = useWidgetData(config);
  
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-white relative">
      <div className="px-6 py-5 border-b border-gh-border flex items-center justify-between bg-white shrink-0 sticky top-0 z-10">
        <h3 className="text-xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
          <i className="ph-fill ph-chart-bar text-gh-blue"></i>
          {config.title}
        </h3>
        <div className="flex items-center gap-2">
          <button onClick={onEdit} className="text-gray-400 hover:text-gh-blue p-1.5 rounded transition-colors" title="Edit Widget">
            <i className="ph-bold ph-pencil-simple"></i>
          </button>
          {items.some((i: any) => i.status) && (
            <>
              <span className="bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-full text-xs font-bold">{items.filter((i: any) => i.status === "pass").length} Pass</span>
              <span className="bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-full text-xs font-bold">{items.filter((i: any) => i.status === "fail").length} Fail</span>
            </>
          )}
          <span className="bg-gray-100 text-gray-600 px-3 py-1.5 rounded-full text-sm font-bold">{items.length} Total</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto bg-gray-50 h-full">
        <WidgetDataTable config={config} items={items} />
      </div>
    </div>
  );
}

function WidgetDataTable({ config, items }: { config: WidgetConfig, items: any[] }) {
  const [selectedItem, setSelectedItem] = useState<any | null>(null);

  if (items.length === 0) {
    return (
      <div className="p-12 text-center text-gray-500">
        <i className="ph-fill ph-check-circle text-4xl text-green-500 mb-3 block opacity-80"></i>
        No data matches this query or preset.
      </div>
    );
  }

  return (
    <>
      <table className="w-full text-left text-sm whitespace-nowrap bg-white">
        <thead className="bg-gray-50 border-b border-gh-border sticky top-0 z-10 shadow-sm">
          <tr>
            <th className="px-6 py-3 font-semibold text-gh-muted w-16">#</th>
            <th className="px-6 py-3 font-semibold text-gh-muted">Entity</th>
            
            {config.type === "preset" && config.presetId === "dependabot" && (
              <>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center text-red-600">Critical</th>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center text-orange-500">High</th>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center text-yellow-600">Medium</th>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center text-gray-500">Low</th>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center">Total</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "bypasses" && (
              <>
                <th className="px-6 py-3 font-semibold text-gh-muted">Bypasses</th>
                <th className="px-6 py-3 font-semibold text-gh-muted w-full">Reason</th>
              </>
            )}
            {config.type === "preset" && config.presetId === "blast" && (
              <>
                <th className="px-6 py-3 font-semibold text-gh-muted">Risk Level</th>
                <th className="px-6 py-3 font-semibold text-gh-muted text-center">Score</th>
              </>
            )}
            {config.type === "query" && items.some((i: any) => i.status) && (
              <th className="px-6 py-3 font-semibold text-gh-muted text-center w-[80px]">Status</th>
            )}
            {config.type === "query" && (
              <th className="px-6 py-3 font-semibold text-gh-muted w-full">Details</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((item: any, idx: number) => {
            const name = item.repo || item.user || item.team || "Unknown";
            const entityType = item.repo ? "REPO" : item.user ? "USER" : item.team ? "TEAM" : "UNKNOWN";
            
            return (
              <tr 
                key={idx}
                className="hover:bg-gray-50 transition-colors cursor-pointer group/row"
                onClick={() => setSelectedItem(item)}
              >
                <td className="px-6 py-3 font-mono text-gh-muted text-xs">{idx + 1}</td>
                <td className="px-6 py-3 font-bold text-gh-textBase flex items-center gap-2">
                  {name}
                  {config.type === "query" && (
                    <span className="text-[9px] font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">{entityType}</span>
                  )}
                  <i className="ph-bold ph-arrows-out-simple text-gray-300 ml-auto mr-2 text-xs opacity-0 group-hover/row:opacity-100 transition-opacity"></i>
                </td>

                {config.type === "preset" && config.presetId === "dependabot" && (
                  <>
                    <td className="px-6 py-3 text-center font-mono font-medium text-red-600">{item.critical || '-'}</td>
                    <td className="px-6 py-3 text-center font-mono font-medium text-orange-500">{item.high || '-'}</td>
                    <td className="px-6 py-3 text-center font-mono font-medium text-yellow-600">{item.medium || '-'}</td>
                    <td className="px-6 py-3 text-center font-mono font-medium text-gray-500">{item.low || '-'}</td>
                    <td className="px-6 py-3 text-center font-mono font-bold bg-gray-50/50">{item.total}</td>
                  </>
                )}
                
                {config.type === "preset" && config.presetId === "bypasses" && (
                  <>
                    <td className="px-6 py-3 font-mono font-bold text-red-600">{item.bypasses}</td>
                    <td className="px-6 py-3 text-sm text-gh-muted truncate">{item.reason}</td>
                  </>
                )}

                {config.type === "preset" && config.presetId === "blast" && (
                  <>
                    <td className="px-6 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold
                        ${item.riskLevel === 'CRITICAL' ? 'bg-red-100 text-red-800' :
                          item.riskLevel === 'HIGH' ? 'bg-orange-100 text-orange-800' :
                          item.riskLevel === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-green-100 text-green-800'}`}>
                        {item.riskLevel}
                      </span>
                    </td>
                    <td className="px-6 py-3 font-mono text-center">{item.score}</td>
                  </>
                )}

                {config.type === "query" && items.some((i: any) => i.status) && (
                  <td className="px-6 py-3 text-center">
                    {item.status === "pass" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full"><i className="ph-bold ph-check-circle text-[11px]"></i>Pass</span>
                    ) : item.status === "fail" ? (
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full"><i className="ph-bold ph-x-circle text-[11px]"></i>Fail</span>
                    ) : null}
                  </td>
                )}
                {config.type === "query" && (
                  <td className="px-6 py-3 text-sm">
                    <span className={`block truncate max-w-xl ${item.status === "fail" ? "text-red-700" : "text-gray-800"}`}>{item.reason}</span>
                    {item.details && <span className="text-xs text-gray-500 font-mono mt-0.5 block truncate max-w-xl">{item.details}</span>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {selectedItem && (
        <RawDetailsModal item={selectedItem} config={config} onClose={() => setSelectedItem(null)} />
      )}
    </>
  );
}

function RawDetailsModal({ item, config, onClose }: { item: any, config: WidgetConfig, onClose: () => void }) {
  const { user } = useAuth();
  const name = item.repo || item.user || item.team || "Unknown Entity";
  
  let githubLink = null;
  if (item.repo) {
    githubLink = `https://github.com/${user?.login || 'org'}/${item.repo}`;
    if (config.type === 'preset' && config.presetId === 'dependabot') {
      githubLink += '/security/dependabot';
    }
  } else if (item.user) {
    githubLink = `https://github.com/${item.user}`;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white shrink-0 rounded-t-xl">
          <h3 className="text-lg font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-info text-gh-blue"></i>
            {name} Raw Attributes
          </h3>
          <div className="flex items-center gap-3">
            {githubLink && (
              <a 
                href={githubLink}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold bg-gray-100 hover:bg-gray-200 text-gray-700 px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 border border-gray-200"
              >
                <i className="ph-fill ph-github-logo text-sm"></i>
                View in GitHub
              </a>
            )}
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>
        <div className="p-6 overflow-y-auto bg-gray-50 flex-1 rounded-b-xl">
          <div className="flex flex-col gap-4">
            {item.status && (
              <div className="flex flex-col border-b border-gray-100 pb-3">
                <span className="text-sm font-bold text-gray-700 mb-1">Status</span>
                <div>
                  {item.status === "pass" ? (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-green-700 bg-green-50 border border-green-200 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-check-circle"></i>Passing</span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-sm font-bold text-red-700 bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg"><i className="ph-bold ph-x-circle"></i>Failing</span>
                  )}
                </div>
              </div>
            )}
            {item.status === "fail" && item.reason && (
              <div className="flex flex-col border-b border-gray-100 pb-3">
                <span className="text-sm font-bold text-gray-700 mb-2">Failure Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).replace(/"/g, "").trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-red-50 border border-red-200 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-red-800 bg-red-100 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-red-700">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {item.status === "pass" && item.reason && (
              <div className="flex flex-col border-b border-gray-100 pb-3">
                <span className="text-sm font-bold text-gray-700 mb-2">Branch Details</span>
                <div className="space-y-2">
                  {item.reason.split(" | ").map((part: string, idx: number) => {
                    const colonIdx = part.indexOf(":");
                    const branchName = colonIdx > 0 ? part.substring(0, colonIdx).trim() : null;
                    const detail = colonIdx > 0 ? part.substring(colonIdx + 1).trim() : part;
                    return (
                      <div key={idx} className="bg-green-50 border border-green-200 rounded-lg p-3">
                        {branchName && <span className="inline-flex items-center gap-1 text-xs font-bold text-green-800 bg-green-100 px-2 py-0.5 rounded-md mb-1.5"><i className="ph-bold ph-git-branch text-[10px]"></i>{branchName}</span>}
                        <p className="text-sm text-green-700">{detail}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {Object.entries(item).filter(([k]) => !['repo', 'user', 'team', 'status', 'reason'].includes(k)).map(([k, v], i) => (
              <div key={i} className="flex flex-col border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-gray-700 mb-1">{k}</span>
                <pre className="text-sm text-gray-800 bg-white p-3 rounded-lg border border-gray-200 overflow-x-auto whitespace-pre-wrap font-mono">
                  {typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)}
                </pre>
              </div>
            ))}
            {!item.status && Object.entries(item).filter(([k]) => ['reason'].includes(k)).map(([k, v], i) => (
              <div key={`r-${i}`} className="flex flex-col border-b border-gray-100 pb-3 last:border-0 last:pb-0">
                <span className="text-sm font-bold text-gray-700 mb-1">{k}</span>
                <pre className="text-sm text-gray-800 bg-white p-3 rounded-lg border border-gray-200 overflow-x-auto whitespace-pre-wrap font-mono">
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

function WidgetDetailsModal({ config, items, onClose }: { config: WidgetConfig, items: any[], onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-4xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white shrink-0 rounded-t-xl">
          <h3 className="text-lg font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <i className="ph-fill ph-chart-bar text-gh-blue"></i>
            {config.title}
          </h3>
          <div className="flex items-center gap-3">
            {items.some((i: any) => i.status) && (
              <>
                <span className="bg-green-50 text-green-700 border border-green-200 px-2.5 py-1 rounded-full text-xs font-bold">{items.filter((i: any) => i.status === "pass").length} Pass</span>
                <span className="bg-red-50 text-red-700 border border-red-200 px-2.5 py-1 rounded-full text-xs font-bold">{items.filter((i: any) => i.status === "fail").length} Fail</span>
              </>
            )}
            <span className="bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full text-xs font-bold">{items.length} Total</span>
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>

        <div className="p-0 overflow-y-auto bg-gray-50 flex-1 relative">
          <WidgetDataTable config={config} items={items} />
        </div>
      </div>
    </div>
  );
}

function WidgetFormModal({ onClose, onSave, isSaving, initialData }: { onClose: () => void, onSave: (config: Omit<WidgetConfig, "id" | "createdBy" | "createdAt" | "updatedAt">) => void, isSaving?: boolean, initialData?: WidgetConfig }) {
  const isEditing = !!initialData;
  const [title, setTitle] = useState(initialData?.title || "");
  const [type, setType] = useState<WidgetType>(initialData?.type || "preset");
  const [presetId, setPresetId] = useState<PresetId>((initialData?.presetId as PresetId) || "dependabot");
  const [displayType, setDisplayType] = useState<DisplayType>(initialData?.displayType || "metric");
  
  // Query State
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
      const resolvedParam = selectedQuery?.useTagInput
        ? branchTags.join(", ")
        : paramValue.trim();
      onSave({
        title,
        type,
        queryId: selectedQueryId,
        queryParam: selectedQuery?.requiresParam ? resolvedParam : undefined,
        queryAdvanced: advanced,
        displayType
      });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">{isEditing ? 'Edit Widget' : 'Add Dashboard Widget'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-900"><i className="ph ph-x text-lg"></i></button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          <div>
            <label className="block text-sm font-semibold text-gh-textBase mb-1">Widget Title</label>
            <input 
              type="text" 
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
              placeholder="e.g. My Custom Metric"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gh-textBase mb-1">Data Source</label>
              <select 
                value={type}
                onChange={(e) => setType(e.target.value as WidgetType)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
              >
                <option value="preset">Built-in Ranking Presets</option>
                <option value="query">Security Insight Query</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold text-gh-textBase mb-1">Display Format</label>
              <select 
                value={displayType}
                onChange={(e) => setDisplayType(e.target.value as DisplayType)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
              >
                <option value="metric">Big Metric (Count)</option>
                <option value="table">List / Table</option>
              </select>
            </div>
          </div>

          <div className="p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-4">
            {type === "preset" ? (
              <div>
                <label className="block text-sm font-semibold text-gh-textBase mb-1">Select Preset</label>
                <select 
                  value={presetId}
                  onChange={(e) => setPresetId(e.target.value as PresetId)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
                >
                  <option value="dependabot">Dependabot Issues Ranking</option>
                  <option value="bypasses">Protection Rule Bypasses</option>
                  <option value="blast">Blast Radius Risk</option>
                </select>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-sm font-semibold text-gh-textBase mb-1">Select Insight Query</label>
                  <select 
                    value={selectedQueryId}
                    onChange={(e) => handleQuerySelect(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
                  >
                    {QUERY_OPTIONS.map(q => (
                      <option key={q.id} value={q.id}>{q.label}</option>
                    ))}
                  </select>
                </div>

                {selectedQuery?.requiresParam && (
                  <div>
                    <label className="block text-sm font-semibold text-gh-textBase mb-1">{selectedQuery.paramLabel}</label>
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
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
                        required
                      />
                    )}
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-3 border-t border-gray-200 space-y-3">
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider">Branch Rule Configuration</label>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-gh-textBase mb-1">Protection Type</label>
                        <select
                          value={protectionType}
                          onChange={(e) => setProtectionType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm outline-none focus:border-gh-blue"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="classic">Must use Classic Protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-gh-textBase mb-1">Rule Matching Mode</label>
                        <select
                          value={ruleMatchType}
                          onChange={(e) => setRuleMatchType(e.target.value)}
                          className="w-full px-2 py-1.5 border border-gray-300 rounded-md text-sm outline-none focus:border-gh-blue"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>
                    </div>

                    {ruleMatchType !== "any" && (
                      <div className="bg-white border border-gray-200 rounded-lg p-3">
                        <h4 className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Required Rules</h4>
                        <div className="grid grid-cols-2 gap-y-2 gap-x-4 text-sm">
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={requirePr} onChange={e => setRequirePr(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                            Require Pull Request
                          </label>
                          {requirePr && (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-gh-muted">Min. Approvals:</span>
                              <input
                                type="number" min={1} max={5}
                                value={minApprovals}
                                onChange={(e) => setMinApprovals(parseInt(e.target.value))}
                                className="w-16 rounded-md border-gray-300 py-1 px-2 text-xs ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
                              />
                            </div>
                          )}
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={dismissStaleReviews} onChange={e => setDismissStaleReviews(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                            Dismiss stale reviews
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventForcePush} onChange={e => setPreventForcePush(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                            Prevent force pushing
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={preventDeletion} onChange={e => setPreventDeletion(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                            Prevent deletion
                          </label>
                          <label className="flex items-center gap-2">
                            <input type="checkbox" checked={enforceAdmins} onChange={e => setEnforceAdmins(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                            Enforce for admins
                          </label>
                        </div>

                        <details className="group/det mt-3">
                          <summary className="text-[11px] font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-gray-100">
                            <i className="ph-bold ph-caret-right text-[10px] group-open/det:rotate-90 transition-transform"></i>
                            Advanced Rules
                          </summary>
                          <div className="grid grid-cols-2 gap-y-2 gap-x-4 pt-3 mt-1 text-sm">
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireCodeOwnerReviews} onChange={e => setRequireCodeOwnerReviews(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                              Require Code Owner review
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireConversationResolution} onChange={e => setRequireConversationResolution(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                              Require conversation resolution
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireStatusChecks} onChange={e => setRequireStatusChecks(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                              Require status checks
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={strictStatusChecks} onChange={e => setStrictStatusChecks(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                              Strict status checks (up to date)
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireSignedCommits} onChange={e => setRequireSignedCommits(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                              Require signed commits
                            </label>
                            <label className="flex items-center gap-2">
                              <input type="checkbox" checked={requireLinearHistory} onChange={e => setRequireLinearHistory(e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
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

          <div className="flex justify-end gap-3 pt-4 border-t border-gh-border">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50" disabled={isSaving}>Cancel</button>
            <button type="submit" className="px-4 py-2 bg-gh-blue text-white rounded-md text-sm font-medium hover:bg-gh-blueHover disabled:opacity-50" disabled={isSaving}>
              {isSaving ? "Saving..." : isEditing ? "Update Widget" : "Save Widget"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
