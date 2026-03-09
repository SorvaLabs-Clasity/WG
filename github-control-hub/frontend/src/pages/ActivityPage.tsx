import { useState, useMemo } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useActivity } from "../hooks/useActivity";
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

export default function ActivityPage() {
  const { user } = useAuth();
  const { data, isLoading, error } = useActivity(100);
  const [search, setSearch] = useState("");
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);

  const filtered = useMemo(() => {
    if (!data?.entries) return [];
    if (!search) return data.entries;
    const q = search.toLowerCase();
    return data.entries.filter(
      (e) =>
        e.actor.toLowerCase().includes(q) ||
        e.repo.toLowerCase().includes(q) ||
        e.target.toLowerCase().includes(q) ||
        e.action.toLowerCase().includes(q)
    );
  }, [data, search]);

  return (
    <div className="bg-gh-bg text-gh-text font-sans antialiased min-h-screen flex flex-col pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 max-w-[1400px] w-full mx-auto px-6 py-8 animate-fade-in">
        
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-gh-textBase">Activity Log</h1>
            <p className="text-sm text-gh-muted mt-1">Audit trail of all organization events and security changes.</p>
          </div>
          
          <div className="relative w-full md:w-96 group">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400 group-focus-within:text-gh-blue transition-colors">
              <i className="fa-solid fa-magnifying-glass text-sm"></i>
            </div>
            <input 
              type="text" 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by user, repo, or action type..." 
              className="w-full pl-9 pr-4 py-2 text-sm bg-white border border-gh-border rounded-md shadow-sm focus:outline-none focus:border-gh-blue focus:ring-1 focus:ring-gh-blue transition-all"
            />
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
                    const cfg = ACTION_CONFIG[entry.action];
                    return (
                      <tr 
                        key={entry.id} 
                        className={`table-row-hover transition-colors group ${entry.diff ? 'cursor-pointer hover:bg-gray-50' : ''}`}
                        onClick={() => entry.diff ? setSelectedActivity(entry) : null}
                      >
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
                <p className="text-sm text-gh-muted mb-1">Action: <strong className="text-gh-textBase">{ACTION_CONFIG[selectedActivity.action].label}</strong></p>
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
