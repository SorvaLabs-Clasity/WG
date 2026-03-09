import { useState, useMemo } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useActivity } from "../hooks/useActivity";
import { useOrgConfig } from "../hooks/useOrgConfig";
import type { ActivityAction } from "../types/Activity";

const ACTION_CONFIG: Record<
  ActivityAction,
  { label: string; colorClass: string; iconClass: string }
> = {
  "branch.create": { 
    label: "Branch Created", 
    colorClass: "bg-green-50 text-green-700 border-green-200/60", 
    iconClass: "fa-solid fa-plus text-[10px]" 
  },
  "branch.delete": { 
    label: "Branch Deleted", 
    colorClass: "bg-red-50 text-red-700 border-red-200/60", 
    iconClass: "fa-solid fa-trash text-[10px]" 
  },
  "branch.protect": { 
    label: "Branch Protected", 
    colorClass: "bg-blue-50 text-blue-700 border-blue-200/60", 
    iconClass: "fa-solid fa-shield text-[10px]" 
  },
  "template.apply": { 
    label: "Template Applied", 
    colorClass: "bg-sky-50 text-sky-700 border-sky-200/60", 
    iconClass: "fa-solid fa-play text-[10px]" 
  },
  "template.create": { 
    label: "Template Created", 
    colorClass: "bg-purple-50 text-purple-700 border-purple-200/60", 
    iconClass: "fa-solid fa-gear text-[10px]" 
  },
  "template.update": { 
    label: "Template Updated", 
    colorClass: "bg-orange-50 text-orange-700 border-orange-200/60", 
    iconClass: "fa-solid fa-pen text-[10px]" 
  },
  "template.delete": { 
    label: "Template Deleted", 
    colorClass: "bg-red-50 text-red-700 border-red-200/60", 
    iconClass: "fa-solid fa-trash text-[10px]" 
  },
  "branch.unprotect": { 
    label: "Branch Unprotected", 
    colorClass: "bg-orange-50 text-orange-700 border-orange-200/60", 
    iconClass: "fa-solid fa-shield-slash text-[10px]" 
  },
  "repo.ruleset.delete": { 
    label: "Ruleset Deleted", 
    colorClass: "bg-red-50 text-red-700 border-red-200/60", 
    iconClass: "fa-solid fa-trash text-[10px]" 
  },
  "github.push": { 
    label: "Code Pushed", 
    colorClass: "bg-teal-50 text-teal-700 border-teal-200/60", 
    iconClass: "fa-solid fa-code-commit text-[10px]" 
  },
  "github.pr_opened": { 
    label: "PR Opened", 
    colorClass: "bg-green-50 text-green-700 border-green-200/60", 
    iconClass: "fa-solid fa-code-pull-request text-[10px]" 
  },
  "github.pr_merged": { 
    label: "PR Merged", 
    colorClass: "bg-purple-50 text-purple-700 border-purple-200/60", 
    iconClass: "fa-solid fa-code-merge text-[10px]" 
  },
  "github.pr_closed": { 
    label: "PR Closed", 
    colorClass: "bg-red-50 text-red-700 border-red-200/60", 
    iconClass: "fa-solid fa-code-pull-request text-[10px]" 
  },
  "github.issue_opened": { 
    label: "Issue Opened", 
    colorClass: "bg-green-50 text-green-700 border-green-200/60", 
    iconClass: "fa-regular fa-circle-dot text-[10px]" 
  },
};

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface Activity {
  id: string;
  action: string;
  actor: string;
  repo: string;
  target: string;
  details?: string;
  diff?: any;
  timestamp: string;
}

export default function ActivityPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useActivity(100);
  const { data: orgConfig } = useOrgConfig();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | "app" | "github">("all");
  const [repoFilter, setRepoFilter] = useState("");
  const [targetFilter, setTargetFilter] = useState("");
  const [selectedActivity, setSelectedActivity] = useState<any | null>(null);

  const filtered = useMemo(() => {
    if (!data?.entries) return [];
    let entries = data.entries;

    if (sourceFilter !== "all") {
      entries = entries.filter((e) => e.source === sourceFilter);
    }
    
    if (repoFilter) {
      const q = repoFilter.toLowerCase();
      entries = entries.filter((e) => e.repo.toLowerCase().includes(q));
    }
    
    if (targetFilter) {
      const q = targetFilter.toLowerCase();
      entries = entries.filter((e) => e.target.toLowerCase().includes(q) || (e.prNumber && e.prNumber.toString() === q) || (e.commitSha && e.commitSha.toLowerCase().includes(q)));
    }

    if (search) {
      const q = search.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.actor.toLowerCase().includes(q) ||
          e.action.toLowerCase().includes(q) ||
          (e.details && e.details.toLowerCase().includes(q))
      );
    }
    
    return entries;
  }, [data, search, sourceFilter, repoFilter, targetFilter]);

  return (
    <div className="bg-gh-bg text-gh-text font-sans antialiased min-h-screen flex flex-col pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8 animate-fade-in">
        
        <header className="flex flex-col mb-6 space-y-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gh-textBase">Activity Log</h1>
            <p className="text-sm text-gh-muted mt-1">Global audit trail of all organization events and security changes.</p>
          </div>
          
          <div className="bg-white p-4 rounded-lg border border-gh-border shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <i className="fa-solid fa-filter text-gh-muted text-sm"></i>
              <span className="text-sm font-semibold text-gh-textBase">Advanced Filters</span>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Source</label>
                <div className="flex flex-col gap-1">
                  <select 
                    value={sourceFilter}
                    onChange={(e) => setSourceFilter(e.target.value as any)}
                    className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none"
                  >
                    <option value="all">All Sources</option>
                    <option value="app">Control Hub App</option>
                    {orgConfig?.features?.auditLogs && (
                      <option value="github">Native GitHub</option>
                    )}
                  </select>
                  {!orgConfig?.features?.auditLogs && (
                    <span className="text-[10px] text-orange-600 flex items-center gap-1">
                      <i className="ph-fill ph-warning-circle"></i>
                      Native GitHub events require Enterprise Audit Logs.
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Repository</label>
                <input 
                  type="text" 
                  value={repoFilter}
                  onChange={(e) => setRepoFilter(e.target.value)}
                  placeholder="e.g. web-platform" 
                  className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Target (Branch/PR)</label>
                <input 
                  type="text" 
                  value={targetFilter}
                  onChange={(e) => setTargetFilter(e.target.value)}
                  placeholder="e.g. main or 42" 
                  className="w-full text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue py-1.5 px-2 outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gh-muted uppercase tracking-wider mb-1">Search Details</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-2 flex items-center pointer-events-none text-gray-400">
                    <i className="fa-solid fa-magnifying-glass text-[11px]"></i>
                  </div>
                  <input 
                    type="text" 
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="User, action, details..." 
                    className="w-full pl-7 pr-3 py-1.5 text-sm bg-gray-50 border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue outline-none"
                  />
                </div>
              </div>
            </div>
            {(sourceFilter !== 'all' || repoFilter || targetFilter || search) && (
              <div className="mt-3 flex justify-end">
                <button 
                  onClick={() => {
                    setSourceFilter('all');
                    setRepoFilter('');
                    setTargetFilter('');
                    setSearch('');
                  }}
                  className="text-[11px] font-medium text-gh-muted hover:text-gh-blue"
                >
                  Clear Filters
                </button>
              </div>
            )}
          </div>
        </header>

        {isLoading && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md mb-6">
            <p className="text-red-700">Failed to load activity: {(error as Error).message}</p>
          </div>
        )}

        {!isLoading && !error && (
          <div className="bg-white rounded-lg border border-gh-border shadow-subtle overflow-hidden relative">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-gray-50 border-b border-gh-border">
                  <tr>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider w-16">Source</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider w-48">Action</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">User</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">Repository</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider">Target</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider hidden lg:table-cell">Details</th>
                    <th className="px-6 py-3 text-xs font-semibold text-gh-muted uppercase tracking-wider text-right">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gh-border">
                  {filtered.map((entry) => {
                    const cfg = ACTION_CONFIG[entry.action as ActivityAction] || { label: entry.action, colorClass: "bg-gray-50", iconClass: "fa-solid fa-circle" };
                    return (
                      <tr 
                        key={entry.id} 
                        className={`table-row-hover transition-colors group ${entry.diff ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                        onClick={() => entry.diff ? setSelectedActivity(entry) : null}
                      >
                        <td className="px-6 py-4 whitespace-nowrap text-center">
                          {entry.source === "github" ? (
                            <i className="fa-brands fa-github text-lg text-gh-textBase" title="Native GitHub Event"></i>
                          ) : (
                            <i className="fa-solid fa-shield-halved text-lg text-gh-blue" title="Control Hub App Event"></i>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${cfg.colorClass}`}>
                            <i className={cfg.iconClass}></i>
                            {cfg.label}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <img src={`https://i.pravatar.cc/48?u=${entry.actor}`} alt={entry.actor} className="w-6 h-6 rounded-full object-cover border border-gray-200" />
                            <span className="text-sm font-medium text-gh-textBase group-hover:text-gh-blue transition-colors">
                              {entry.actor}
                            </span>
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${
                            entry.repo === '*' ? 'bg-gray-600 text-white border-gray-700' : 'bg-gray-100 text-gray-700 border-gray-200'
                          }`}>
                            {entry.repo === '*' ? '* (Global)' : entry.repo}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className="font-mono text-xs text-gh-textBase bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200/50">
                            {entry.action.includes('branch') ? (
                              <i className="fa-solid fa-code-branch text-[10px] text-gray-400 mr-1"></i>
                            ) : null}
                            {entry.target}
                          </span>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap hidden lg:table-cell">
                          <div className="flex items-center justify-between gap-4 max-w-xs">
                            <span className="text-sm text-gh-muted truncate" title={entry.details}>
                              {entry.details || "—"}
                            </span>
                            {entry.diff && (
                              <span className="text-[10px] text-gh-blue bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                                View Changes
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right">
                          <span className="text-sm text-gh-muted" title={entry.timestamp}>
                            {formatTimestamp(entry.timestamp)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-gh-muted">
                        No activity found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-6 py-3 border-t border-gh-border bg-gray-50 flex items-center justify-between">
              <span className="text-xs text-gh-muted">Showing <strong>{filtered.length}</strong> events</span>
              <div className="flex gap-2">
                <button className="px-3 py-1 text-xs font-medium text-gh-muted border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-50" disabled>Previous</button>
                <button className="px-3 py-1 text-xs font-medium text-gh-textBase border border-gh-border rounded bg-white hover:bg-gray-100 disabled:opacity-50" disabled>Next</button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* DIFF MODAL */}
      {selectedActivity && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setSelectedActivity(null)}></div>
          
          <div className="bg-white rounded-lg shadow-modal border border-black/10 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[85vh]">
            <div className="bg-white px-6 py-4 border-b border-gh-border flex justify-between items-center rounded-t-lg shrink-0">
              <h3 className="text-lg font-bold text-gh-textBase">Activity Details</h3>
              <button onClick={() => setSelectedActivity(null)} className="text-gray-400 hover:text-gray-600 transition-colors">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              <div className="mb-4">
                <p className="text-sm text-gh-muted mb-1">Action: <strong className="text-gh-textBase">{ACTION_CONFIG[selectedActivity.action as ActivityAction]?.label || selectedActivity.action}</strong></p>
                <p className="text-sm text-gh-muted mb-1">Target: <code className="bg-gray-100 px-1 rounded">{selectedActivity.target}</code></p>
                <p className="text-sm text-gh-muted">Details: {selectedActivity.details}</p>
              </div>

              {selectedActivity.diff && (
                <div>
                  <h4 className="text-sm font-semibold text-gh-textBase mb-3 mt-6 border-b pb-2">Changes Made</h4>
                  <div className="space-y-4">
                    {Object.entries(selectedActivity.diff).map(([key, changes]: [string, any]) => (
                      <div key={key} className="border border-gh-border rounded-md overflow-hidden">
                        <div className="bg-gray-50 px-3 py-1.5 border-b border-gh-border text-xs font-mono font-semibold text-gray-600 uppercase tracking-wider">
                          {key}
                        </div>
                        <div className="grid grid-cols-2 divide-x divide-gh-border bg-white text-sm font-mono overflow-x-auto">
                          <div className="p-3 bg-red-50/30 text-red-800">
                            <div className="text-[10px] text-red-500 mb-1 uppercase tracking-wider font-sans">Previous</div>
                            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(changes.old, null, 2)}</pre>
                          </div>
                          <div className="p-3 bg-green-50/30 text-green-800">
                            <div className="text-[10px] text-green-500 mb-1 uppercase tracking-wider font-sans">New</div>
                            <pre className="whitespace-pre-wrap break-all">{JSON.stringify(changes.new, null, 2)}</pre>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3 border-t border-gh-border rounded-b-lg shrink-0">
              <button 
                onClick={() => setSelectedActivity(null)} 
                className="inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
