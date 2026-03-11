import React, { useState, useMemo, useEffect } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useSecurityQuery, useBlastRadiusRanking } from "../hooks/useGraph";
import { useDependencies } from "../hooks/useDependencies";
import { useRepos } from "../hooks/useRepos";
import { QUERY_OPTIONS } from "../utils/queryOptions";

type WidgetType = "preset" | "query";
type DisplayType = "metric" | "table";
type PresetId = "dependabot" | "bypasses" | "blast";

interface WidgetConfig {
  id: string;
  title: string;
  type: WidgetType;
  presetId?: PresetId;
  queryId?: string;
  queryParam?: string;
  queryAdvanced?: any;
  displayType: DisplayType;
}

const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: "1", title: "Protection Rule Bypasses", type: "preset", presetId: "bypasses", displayType: "table" },
  { id: "2", title: "Dependabot Issues", type: "preset", presetId: "dependabot", displayType: "table" },
  { id: "3", title: "Repos missing main branch", type: "query", queryId: "repos-missing-branch", queryParam: "main", displayType: "metric" },
  { id: "4", title: "Blast Radius Risk", type: "preset", presetId: "blast", displayType: "table" },
];

export default function AnalyticsPage() {
  const { user } = useAuth();
  
  const [widgets, setWidgets] = useState<WidgetConfig[]>(() => {
    const saved = localStorage.getItem("gh-control-hub-widgets");
    return saved ? JSON.parse(saved) : DEFAULT_WIDGETS;
  });

  useEffect(() => {
    localStorage.setItem("gh-control-hub-widgets", JSON.stringify(widgets));
  }, [widgets]);

  const [showAddModal, setShowAddModal] = useState(false);

  const handleAddWidget = (config: Omit<WidgetConfig, "id">) => {
    setWidgets([...widgets, { ...config, id: Date.now().toString() }]);
    setShowAddModal(false);
  };

  const removeWidget = (id: string) => {
    setWidgets(widgets.filter(w => w.id !== id));
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
          <button 
            onClick={() => setShowAddModal(true)}
            className="bg-gh-blue hover:bg-gh-blueHover text-white px-4 py-2 rounded-md text-sm font-semibold shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <i className="fa-solid fa-plus text-xs"></i>
            Add Widget
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 grid-flow-dense">
          {widgets.map(widget => (
            <WidgetCard key={widget.id} config={widget} onRemove={() => removeWidget(widget.id)} />
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
      </main>

      {showAddModal && <AddWidgetModal onClose={() => setShowAddModal(false)} onSave={handleAddWidget} />}
    </div>
  );
}

function WidgetCard({ config, onRemove }: { config: WidgetConfig, onRemove: () => void }) {
  const { data: depsData, isLoading: depsLoading } = useDependencies();
  const { data: blastData, isLoading: blastLoading } = useBlastRadiusRanking();
  const isBypass = config.type === "preset" && config.presetId === "bypasses";
  const { data: bypassData, isLoading: bypassLoading } = useSecurityQuery(isBypass ? "protection-bypasses-ranking" : null);
  
  const isQuery = config.type === "query";
  const { data: queryData, isLoading: queryLoading } = useSecurityQuery(isQuery ? config.queryId! : null, config.queryParam, config.queryAdvanced);
  
  const { data: repos } = useRepos();
  
  const [showDetails, setShowDetails] = useState(false);

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
              {config.displayType === "metric" && (
                <div 
                  className="flex-1 flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 rounded-lg transition-colors" 
                  onClick={() => setShowDetails(true)}
                >
                  <div className="text-6xl font-light text-gh-blue mb-2">
                    {items.length} {total !== null && <span className="text-3xl text-gray-400 font-normal">/ {total}</span>}
                  </div>
                  <div className="text-xs text-gh-blue font-semibold mt-4 flex items-center gap-1 opacity-0 group-hover/content:opacity-100 transition-opacity">
                    View Details <i className="ph-bold ph-arrow-right"></i>
                  </div>
                </div>
              )}

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
                              <span className="font-medium text-gh-textBase truncate mr-3">{name}</span>
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
          <div className="flex items-center gap-4">
            <span className="bg-gray-100 text-gray-600 px-2.5 py-1 rounded-full text-xs font-bold">{items.length} Total</span>
            <button onClick={onClose} className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors">
              <i className="ph ph-x text-lg"></i>
            </button>
          </div>
        </div>

        <div className="p-0 overflow-y-auto bg-gray-50 flex-1">
          {items.length === 0 ? (
            <div className="p-12 text-center text-gray-500">
              <i className="ph-fill ph-check-circle text-4xl text-green-500 mb-3 block opacity-80"></i>
              No data matches this query or preset.
            </div>
          ) : (
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
                    <tr key={idx} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3 font-mono text-gh-muted text-xs">{idx + 1}</td>
                      <td className="px-6 py-3 font-bold text-gh-textBase flex items-center gap-2">
                        {name}
                        {config.type === "query" && (
                          <span className="text-[9px] font-mono bg-gray-100 px-1.5 py-0.5 rounded text-gray-500">{entityType}</span>
                        )}
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

                      {config.type === "query" && (
                        <td className="px-6 py-3 text-sm">
                          <span className="text-gray-800 block truncate max-w-xl">{item.reason}</span>
                          {item.details && <span className="text-xs text-gray-500 font-mono mt-0.5 block truncate max-w-xl">{item.details}</span>}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function AddWidgetModal({ onClose, onSave }: { onClose: () => void, onSave: (config: Omit<WidgetConfig, "id">) => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<WidgetType>("preset");
  const [presetId, setPresetId] = useState<PresetId>("dependabot");
  const [displayType, setDisplayType] = useState<DisplayType>("metric");
  
  // Query State
  const [selectedQueryId, setSelectedQueryId] = useState<string>(QUERY_OPTIONS[0].id);
  const [paramValue, setParamValue] = useState<string>("");
  const [protectionType, setProtectionType] = useState<string>("any");
  const [requirePr, setRequirePr] = useState(false);
  const [requireStatusChecks, setRequireStatusChecks] = useState(false);
  const [enforceAdmins, setEnforceAdmins] = useState(false);

  const selectedQuery = QUERY_OPTIONS.find(q => q.id === selectedQueryId);

  const handleQuerySelect = (id: string) => {
    setSelectedQueryId(id);
    const q = QUERY_OPTIONS.find(opt => opt.id === id);
    if (q?.requiresParam && q.paramDefault) setParamValue(q.paramDefault);
    else setParamValue("");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    if (type === "preset") {
      onSave({ title, type, presetId, displayType });
    } else {
      let advanced = undefined;
      if (selectedQuery?.hasAdvancedRules) {
        advanced = { protectionType, requirePr, requireStatusChecks, enforceAdmins };
      }
      onSave({
        title,
        type,
        queryId: selectedQueryId,
        queryParam: selectedQuery?.requiresParam ? paramValue.trim() : undefined,
        queryAdvanced: advanced,
        displayType
      });
    }
  };

  // Auto-generate title if empty
  useEffect(() => {
    if (title === "") {
      if (type === "preset") {
        if (presetId === "dependabot") setTitle("Dependabot Issues");
        if (presetId === "bypasses") setTitle("Protection Rule Bypasses");
        if (presetId === "blast") setTitle("Blast Radius Risk");
      } else if (selectedQuery) {
        let t = selectedQuery.label.replace("...", "");
        if (paramValue) t += ` (${paramValue})`;
        setTitle(t);
      }
    }
  }, [type, presetId, selectedQueryId, paramValue]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-sm animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-xl relative z-10 animate-slide-up flex flex-col">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between">
          <h3 className="text-lg font-bold text-gray-900">Add Dashboard Widget</h3>
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
                    <input 
                      type="text" 
                      value={paramValue}
                      onChange={(e) => setParamValue(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-gh-blue outline-none text-sm"
                      required
                    />
                  </div>
                )}

                {selectedQuery?.hasAdvancedRules && (
                  <div className="pt-2 border-t border-gray-200">
                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Advanced Rules</label>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <select 
                        value={protectionType}
                        onChange={(e) => setProtectionType(e.target.value)}
                        className="px-2 py-1 border border-gray-300 rounded-md text-sm"
                      >
                        <option value="any">Any protection</option>
                        <option value="classic">Classic only</option>
                        <option value="ruleset">Ruleset only</option>
                      </select>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={requirePr} onChange={e => setRequirePr(e.target.checked)} className="rounded" /> Require PRs</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={requireStatusChecks} onChange={e => setRequireStatusChecks(e.target.checked)} className="rounded" /> Require Status</label>
                      <label className="flex items-center gap-2"><input type="checkbox" checked={enforceAdmins} onChange={e => setEnforceAdmins(e.target.checked)} className="rounded" /> Enforce Admins</label>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gh-border">
            <button type="button" onClick={onClose} className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium hover:bg-gray-50">Cancel</button>
            <button type="submit" className="px-4 py-2 bg-gh-blue text-white rounded-md text-sm font-medium hover:bg-gh-blueHover">Save Widget</button>
          </div>
        </form>
      </div>
    </div>
  );
}
