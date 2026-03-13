import React, { useState } from "react";
import { useAlerts, useResolveAlert, useUnresolveAlert, useInactiveUsers } from "../hooks/useAlerts";
import { SecurityAlert } from "../types/Alert";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";

const SEVERITY_CONFIG: Record<string, { color: string; icon: string; bg: string }> = {
  critical: { color: "text-red-600 dark:text-red-400", bg: "bg-red-50 dark:bg-red-950/50", icon: "ph-fill ph-warning-octagon" },
  high: { color: "text-orange-600 dark:text-orange-400", bg: "bg-orange-50 dark:bg-orange-950/50", icon: "ph-fill ph-warning" },
  medium: { color: "text-yellow-600 dark:text-yellow-400", bg: "bg-yellow-50 dark:bg-yellow-950/50", icon: "ph-fill ph-info" },
  low: { color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-50 dark:bg-blue-950/50", icon: "ph-fill ph-info" },
};

const TYPE_LABELS: Record<string, string> = {
  protection_removed: "Protection Removed",
  ruleset_disabled: "Ruleset Disabled",
  repo_made_public: "Repository Made Public",
  admin_added: "Admin/Outside Access Granted",
  protection_drift: "Protection Drift Detected",
  user_promoted: "User Promoted to Admin",
  team_elevated: "Team Permissions Elevated",
  team_added: "Team Added to Repo",
  team_removed: "Team Removed from Repo",
  team_permission_changed: "Team Permission Changed",
  suspicious_activity: "Suspicious Activity",
};

export default function SecurityPage() {
  const { data: alerts, isLoading: alertsLoading } = useAlerts();
  const { data: inactiveUsers, isLoading: usersLoading } = useInactiveUsers();
  const resolveMutation = useResolveAlert();
  const unresolveMutation = useUnresolveAlert();
  const [filter, setFilter] = useState<"all" | "active" | "resolved">("active");
  const [currentPage, setCurrentPage] = useState(1);
  const { user } = useAuth();
  const ALERTS_PER_PAGE = 8; // Reduced to prevent extending too far down

  const isLoading = alertsLoading || usersLoading;

  if (isLoading) {
    return (
      <div className="bg-gh-bg dark:bg-slate-950 text-gh-textBase dark:text-slate-200 min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-8 flex justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-gh-blue border-t-transparent rounded-full"></div>
        </div>
      </div>
    );
  }

  const filteredAlerts = (alerts || []).filter((alert) => {
    if (filter === "active") return !alert.resolved;
    if (filter === "resolved") return alert.resolved;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filteredAlerts.length / ALERTS_PER_PAGE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedAlerts = filteredAlerts.slice((safePage - 1) * ALERTS_PER_PAGE, safePage * ALERTS_PER_PAGE);

  const handleResolve = (id: string) => {
    resolveMutation.mutate(id);
  };

  const handleUnresolve = (id: string) => {
    unresolveMutation.mutate(id);
  };

  return (
    <div className="bg-gh-bg dark:bg-slate-950 text-gh-textBase dark:text-slate-200 min-h-screen pt-14 flex flex-col h-screen overflow-hidden">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="max-w-7xl mx-auto w-full p-4 sm:p-6 flex-1 flex flex-col overflow-hidden animate-fade-in">
        {/* Header Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6 shrink-0">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase dark:text-slate-200 flex items-center gap-2">
              <i className="ph-fill ph-shield-warning text-gh-textMuted dark:text-slate-400"></i>
              Security Hub
            </h1>
            <p className="text-gh-muted dark:text-slate-400 text-sm mt-1">
              Monitor, investigate, and resolve security events across your organization.
            </p>
          </div>
          
        </div>

        {/* Content Layout */}
        <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0">
          
          {/* Main Alerts Panel */}
          <div className="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-900 rounded-xl border border-gh-border dark:border-slate-700 shadow-sm overflow-hidden">
            {/* Toolbar */}
            <div className="px-5 py-3 border-b border-gh-border dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex items-center justify-between shrink-0">
              <div className="flex gap-1 bg-gray-200/50 dark:bg-slate-700 p-1 rounded-lg">
                {(["active", "resolved", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => { setFilter(f); setCurrentPage(1); }}
                    className={`px-4 py-1.5 text-[13px] font-semibold rounded-md capitalize transition-all ${
                      filter === f
                        ? "bg-white dark:bg-slate-900 text-gh-textBase dark:text-slate-200 shadow-sm"
                        : "text-gh-textMuted dark:text-slate-400 hover:text-gh-textBase dark:hover:text-slate-200 hover:bg-white/50 dark:hover:bg-slate-800/50"
                    }`}
                  >
                    {f}
                    <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400">
                      {f === "active" ? alerts?.filter(a => !a.resolved).length || 0 : f === "resolved" ? alerts?.filter(a => a.resolved).length || 0 : alerts?.length || 0}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Scrollable Alerts List */}
            <div className="flex-1 overflow-y-auto p-4 bg-gray-50/30 dark:bg-slate-800/30">
              {filteredAlerts.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center p-12 text-center text-gh-muted dark:text-slate-400">
                  <div className="w-16 h-16 bg-green-50 dark:bg-green-950/50 rounded-full flex items-center justify-center mb-4">
                    <i className="ph-fill ph-shield-check text-3xl text-green-500"></i>
                  </div>
                  <h3 className="text-base font-semibold text-gh-textBase dark:text-slate-200">No {filter} alerts</h3>
                  <p className="text-sm mt-1">Your organization is secure.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pagedAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`bg-white dark:bg-slate-900 rounded-lg border ${
                        alert.resolved ? "border-gray-200 dark:border-slate-700 bg-gray-50/50 dark:bg-slate-800/50 opacity-80" : "border-gh-border dark:border-slate-700 shadow-sm hover:shadow-md hover:border-gray-300 dark:hover:border-slate-600"
                      } p-4 flex flex-col sm:flex-row gap-4 justify-between transition-all`}
                    >
                      <div className="flex gap-3 items-start min-w-0 flex-1">
                        <div className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${SEVERITY_CONFIG[alert.severity].bg}`}>
                          <i className={`text-lg ${SEVERITY_CONFIG[alert.severity].icon} ${SEVERITY_CONFIG[alert.severity].color}`}></i>
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* Title line with flex-wrap and whitespace-nowrap to prevent overflow */}
                          <div className="flex flex-wrap items-center gap-2 mb-1.5">
                            <span className="text-sm font-bold text-gh-textBase dark:text-slate-200 truncate max-w-full" title={alert.repo}>{alert.repo}</span>
                            <span className={`inline-flex items-center whitespace-nowrap text-[10px] font-bold px-2 py-0.5 rounded-full border ${alert.resolved ? 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400 border-gray-200 dark:border-slate-700' : 'bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 border-red-100 dark:border-red-800'}`}>
                              {TYPE_LABELS[alert.type] || alert.type}
                            </span>
                            <span className="text-xs text-gh-muted dark:text-slate-400 ml-auto">
                              {new Date(alert.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                            </span>
                          </div>
                          
                          <p className={`text-[13px] leading-snug ${alert.resolved ? "text-gh-muted dark:text-slate-400 line-through" : "text-gh-textBase dark:text-slate-200"}`}>
                            {alert.message}
                          </p>

                          {alert.details && !alert.resolved && (
                            <div className="mt-2.5 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-md p-2.5 text-[11px] font-mono text-gh-muted dark:text-slate-400 max-h-32 overflow-y-auto">
                              {JSON.stringify(alert.details, null, 2)}
                            </div>
                          )}

                          {alert.resolved && alert.resolvedBy && (
                            <div className="mt-2 flex items-center gap-1.5 text-[11px] text-gh-muted dark:text-slate-400 bg-gray-100/50 dark:bg-slate-700/50 w-fit px-2 py-1 rounded border border-gray-100 dark:border-slate-700">
                              <i className="ph-bold ph-check-circle text-green-600"></i>
                              <span>Resolved by <span className="font-semibold">{alert.resolvedBy}</span> on {new Date(alert.resolvedAt!).toLocaleDateString()}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex shrink-0 sm:self-center">
                        {!alert.resolved ? (
                          <button
                            onClick={() => handleResolve(alert.id)}
                            disabled={resolveMutation.isPending}
                            className="px-3 py-1.5 text-xs font-semibold text-gh-textBase dark:text-slate-200 bg-white dark:bg-slate-800 border border-gh-border dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-md shadow-sm transition-colors flex items-center gap-1.5"
                          >
                            <i className="ph-bold ph-check text-green-600"></i>
                            Resolve
                          </button>
                        ) : (
                          <button
                            onClick={() => handleUnresolve(alert.id)}
                            disabled={unresolveMutation.isPending}
                            className="px-3 py-1.5 text-xs font-semibold text-gh-muted dark:text-slate-400 bg-white dark:bg-slate-800 border border-gh-border dark:border-slate-600 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-md transition-colors flex items-center gap-1.5"
                          >
                            <i className="ph-bold ph-arrow-u-up-left"></i>
                            Unresolve
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pagination Footer */}
            <div className="px-5 py-3 border-t border-gh-border dark:border-slate-700 bg-white dark:bg-slate-900 flex items-center justify-between shrink-0">
              <span className="text-xs text-gh-muted dark:text-slate-400">
                {filteredAlerts.length > 0 ? (
                  <>Showing {(safePage - 1) * ALERTS_PER_PAGE + 1}&ndash;{Math.min(safePage * ALERTS_PER_PAGE, filteredAlerts.length)} of {filteredAlerts.length}</>
                ) : (
                  "0 alerts"
                )}
              </span>
              
              {totalPages > 1 && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setCurrentPage(1)}
                    disabled={safePage <= 1}
                    className="px-2 py-1 text-xs font-medium border border-gh-border dark:border-slate-600 rounded bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <i className="ph-bold ph-caret-double-left text-[10px]"></i>
                  </button>
                  <button
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={safePage <= 1}
                    className="px-2 py-1 text-xs font-medium border border-gh-border dark:border-slate-600 rounded bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <i className="ph-bold ph-caret-left text-[10px]"></i>
                  </button>
                  {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                    let page: number;
                    if (totalPages <= 5) {
                      page = i + 1;
                    } else if (safePage <= 3) {
                      page = i + 1;
                    } else if (safePage >= totalPages - 2) {
                      page = totalPages - 4 + i;
                    } else {
                      page = safePage - 2 + i;
                    }
                    return (
                      <button
                        key={page}
                        onClick={() => setCurrentPage(page)}
                        className={`px-2.5 py-1.5 min-w-[28px] text-xs font-medium rounded border transition-colors ${safePage === page ? 'bg-gh-blue text-white border-gh-blue' : 'border-transparent bg-transparent hover:bg-gray-100 dark:hover:bg-slate-700 text-gh-textBase dark:text-slate-200'}`}
                      >
                        {page}
                      </button>
                    );
                  })}
                  <button
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={safePage >= totalPages}
                    className="px-2 py-1 text-xs font-medium border border-gh-border dark:border-slate-600 rounded bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <i className="ph-bold ph-caret-right text-[10px]"></i>
                  </button>
                  <button
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={safePage >= totalPages}
                    className="px-2 py-1 text-xs font-medium border border-gh-border dark:border-slate-600 rounded bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <i className="ph-bold ph-caret-double-right text-[10px]"></i>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Sidebar: Inactive Users */}
          <div className="w-full lg:w-80 flex flex-col min-w-0 bg-white dark:bg-slate-900 rounded-xl border border-gh-border dark:border-slate-700 shadow-sm overflow-hidden shrink-0 h-fit max-h-full">
            <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800 border-b border-gh-border dark:border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <i className="ph-fill ph-users text-gh-muted dark:text-slate-400"></i>
                <h3 className="font-bold text-gh-textBase dark:text-slate-200 text-[13px]">Stale Accounts</h3>
              </div>
              <span className="bg-red-100 dark:bg-red-950/50 text-red-600 dark:text-red-400 text-[10px] font-bold px-1.5 py-0.5 rounded">
                180+ Days
              </span>
            </div>
            
            <div className="overflow-y-auto flex-1">
              {(!inactiveUsers || inactiveUsers.length === 0) ? (
                <div className="p-8 text-center text-[13px] text-gh-muted dark:text-slate-400">
                  <i className="ph-fill ph-check-circle text-2xl text-green-500 mb-2 block mx-auto"></i>
                  No stale accounts found.
                </div>
              ) : (
                <ul className="divide-y divide-gray-100 dark:divide-slate-700">
                  {inactiveUsers.map(u => (
                    <li key={u.username} className="px-4 py-3 hover:bg-gray-50 dark:hover:bg-slate-800 flex flex-col gap-2 transition-colors group">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-semibold text-gh-textBase dark:text-slate-200 truncate">{u.username}</span>
                          {u.role === 'admin' && (
                            <i className="ph-fill ph-shield-star text-orange-500 text-xs" title="Admin"></i>
                          )}
                        </div>
                        <button className="opacity-0 group-hover:opacity-100 text-[11px] font-semibold text-red-600 dark:text-red-400 hover:text-white border border-red-200 dark:border-red-800 hover:border-red-600 hover:bg-red-600 px-2 py-0.5 rounded transition-all">
                          Revoke
                        </button>
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-gh-muted dark:text-slate-400">
                        <span className="uppercase font-bold tracking-wider">{u.role}</span>
                        <span>Active {new Date(u.lastActive).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            
            <div className="px-4 py-2.5 bg-blue-50/50 dark:bg-blue-950/50 border-t border-blue-100/50 dark:border-blue-800/50 text-[11px] text-blue-800 dark:text-blue-300 flex items-start gap-2">
              <i className="ph-fill ph-info mt-0.5 shrink-0"></i>
              <p>Stale accounts retain access but are unused, increasing the risk of unauthorized entry.</p>
            </div>
          </div>
          
        </div>
      </main>
    </div>
  );
}
