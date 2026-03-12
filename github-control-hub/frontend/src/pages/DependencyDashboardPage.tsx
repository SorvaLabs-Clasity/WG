import React, { useState, useMemo } from "react";
import { useDependencies, useDependencySummary, useEnableDependabot, useDisableDependabot } from "../hooks/useDependencies";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { DependencyAlert } from "../types/Dependabot";

export default function DependencyDashboardPage() {
  const { data: dependencies, isLoading: depsLoading } = useDependencies();
  const { data: summary, isLoading: sumLoading } = useDependencySummary();
  const enableMutation = useEnableDependabot();
  const disableMutation = useDisableDependabot();
  const { user } = useAuth();
  
  const [filterSeverity, setFilterSeverity] = useState<string>("all-alerts");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const REPOS_PER_PAGE = 20;

  const handleEnable = async (repo: string) => {
    setLoadingRepo(repo);
    try {
      await enableMutation.mutateAsync(repo);
    } finally {
      setLoadingRepo(null);
    }
  };

  const handleDisable = async (repo: string) => {
    if (!window.confirm(`Are you sure you want to disable Dependabot alerts for ${repo}?`)) return;
    setLoadingRepo(repo);
    try {
      await disableMutation.mutateAsync(repo);
    } finally {
      setLoadingRepo(null);
    }
  };

  const isLoading = depsLoading || sumLoading;

  if (isLoading) {
    return (
      <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-8 flex justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-gh-blue border-t-transparent rounded-full"></div>
        </div>
      </div>
    );
  }

  // Group by repo
  const repoGroups: Record<string, DependencyAlert[]> = {};
  
  const filteredDeps = (dependencies || []).filter(dep => {
    // If there is a search query, ignore all other filters and just match the repo name
    if (searchQuery) {
      return dep.repo.toLowerCase().includes(searchQuery.toLowerCase());
    }
    
    if (filterSeverity === "all-repos") {
      return true;
    } else if (filterSeverity === "all-alerts") {
      if (dep.disabled || dep.clean) return false;
    } else {
      // For specific severities (critical, high, medium, low)
      if (dep.disabled || dep.clean) return false;
      if (dep.severity !== filterSeverity) return false;
    }

    return true;
  });

  filteredDeps.forEach(dep => {
    if (!repoGroups[dep.repo]) {
      repoGroups[dep.repo] = [];
    }
    repoGroups[dep.repo].push(dep);
  });

  const getSeverityColor = (sev: string) => {
    switch(sev) {
      case 'critical': return 'text-red-600 bg-red-50 border-red-200';
      case 'high': return 'text-orange-600 bg-orange-50 border-orange-200';
      case 'medium': return 'text-yellow-600 bg-yellow-50 border-yellow-200';
      case 'low': return 'text-blue-600 bg-blue-50 border-blue-200';
      default: return 'text-gray-600 bg-gray-50 border-gray-200';
    }
  };

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-6xl mx-auto p-4 sm:p-8 animate-fade-in">
        
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gh-textBase flex items-center gap-2">
            <i className="ph-fill ph-bug text-gh-textMuted"></i>
            Dependency Security
          </h1>
          <p className="text-gh-muted text-sm mt-1">
            Aggregate vulnerability data across all repositories using GitHub Dependabot alerts.
          </p>
        </div>

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
            <div className="bg-white border border-red-200 rounded-xl p-4 shadow-sm flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-red-600">{summary.critical}</span>
              <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider mt-1">Critical</span>
            </div>
            <div className="bg-white border border-orange-200 rounded-xl p-4 shadow-sm flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-orange-600">{summary.high}</span>
              <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider mt-1">High</span>
            </div>
            <div className="bg-white border border-yellow-200 rounded-xl p-4 shadow-sm flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-yellow-600">{summary.medium}</span>
              <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider mt-1">Medium</span>
            </div>
            <div className="bg-white border border-blue-200 rounded-xl p-4 shadow-sm flex flex-col items-center justify-center">
              <span className="text-3xl font-bold text-blue-600">{summary.low}</span>
              <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider mt-1">Low</span>
            </div>
            <div className="bg-white border border-gh-border rounded-xl p-4 shadow-sm flex flex-col items-center justify-center bg-gray-50">
              <span className="text-3xl font-bold text-gh-textBase">{summary.repos_with_vulns}</span>
              <span className="text-xs font-semibold text-gh-muted uppercase tracking-wider mt-1 text-center">Affected Repos</span>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6 border-b border-gh-border pb-4 justify-between">
          <div className="flex flex-wrap gap-2">
            {[
              { id: "all-alerts", label: "All Alerts" },
              { id: "all-repos", label: "All Repos" },
              { id: "critical", label: "Critical" },
              { id: "high", label: "High" },
              { id: "medium", label: "Medium" },
              { id: "low", label: "Low" }
            ].map((sev) => (
              <button
                key={sev.id}
                onClick={() => { setFilterSeverity(sev.id); setCurrentPage(1); }}
                className={`px-4 py-1.5 text-sm font-semibold rounded-full transition-colors ${
                  filterSeverity === sev.id
                    ? "bg-gh-blue text-white"
                    : "bg-white border border-gh-border text-gh-textMuted hover:text-gh-textBase"
                }`}
              >
                {sev.label}
              </button>
            ))}
          </div>
          
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative w-full sm:w-64">
              <input 
                type="text" 
                placeholder="Search repositories..." 
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
                className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue"
              />
              <i className="ph-bold ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
            </div>
          </div>
        </div>

        {/* Repositories List */}
        {(() => {
          const allEntries = Object.entries(repoGroups);
          const totalPages = Math.ceil(allEntries.length / REPOS_PER_PAGE);
          const paginatedEntries = allEntries.slice((currentPage - 1) * REPOS_PER_PAGE, currentPage * REPOS_PER_PAGE);
          return (
            <>
        <div className="space-y-6">
          {allEntries.length === 0 ? (
            <div className="bg-white rounded-[12px] border border-gh-border p-12 text-center">
              <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <i className="ph-fill ph-check-circle text-3xl text-green-500"></i>
              </div>
              <h3 className="text-lg font-semibold text-gh-textBase">No vulnerabilities found</h3>
              <p className="text-gh-muted mt-1">Great job keeping dependencies up to date.</p>
            </div>
          ) : (
            paginatedEntries.map(([repoName, alerts]) => (
              <div key={repoName} className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
                <div className="bg-gray-50 px-5 py-3 border-b border-gh-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <i className="ph ph-git-repository text-gh-muted"></i>
                    <h3 className="font-bold text-gh-textBase">{repoName}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {alerts[0]?.org && (
                      <a
                        href={`https://github.com/${alerts[0].org}/${repoName}/security/dependabot`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-xs font-semibold text-gh-textMuted hover:text-gh-blue bg-white border border-gh-border hover:border-gh-blue px-2.5 py-1.5 rounded-md transition-colors shadow-sm"
                      >
                        <i className="ph ph-arrow-square-out"></i>
                        View in GitHub
                      </a>
                    )}
                    {alerts[0] && !alerts[0].disabled && (
                      <button
                        onClick={() => handleDisable(repoName)}
                        disabled={loadingRepo === repoName}
                        className="flex items-center gap-1.5 text-xs font-semibold text-red-600 hover:text-red-700 bg-white border border-red-200 hover:border-red-300 px-2.5 py-1.5 rounded-md transition-colors shadow-sm"
                      >
                        {loadingRepo === repoName ? (
                          <div className="animate-spin w-3 h-3 border-2 border-red-600 border-t-transparent rounded-full"></div>
                        ) : (
                          <i className="ph ph-shield-slash"></i>
                        )}
                        Disable
                      </button>
                    )}
                  </div>
                </div>
                
                <div className="p-2">
                  {alerts.map(alert => {
                    if (alert.disabled) {
                      return (
                        <div key={alert.id} className="px-3 py-3 flex items-center justify-between text-sm text-gh-muted bg-gray-50 rounded-lg m-2 border border-gray-200 border-dashed">
                          <div className="flex items-center gap-3">
                            <i className="ph-fill ph-warning-circle text-yellow-500 text-lg"></i>
                            <span>Dependabot alerts disabled</span>
                          </div>
                          <button 
                            onClick={() => handleEnable(alert.repo)}
                            disabled={loadingRepo === alert.repo}
                            className="bg-white border border-gh-border px-3 py-1.5 rounded-md text-xs font-semibold hover:bg-gray-50 flex items-center gap-2"
                          >
                            {loadingRepo === alert.repo ? (
                              <div className="animate-spin w-3 h-3 border-2 border-gh-blue border-t-transparent rounded-full"></div>
                            ) : (
                              <i className="ph ph-shield-check"></i>
                            )}
                            Enable
                          </button>
                        </div>
                      );
                    }

                    if (alert.clean) {
                      return (
                        <div key={alert.id} className="px-4 py-6 text-center text-sm text-gh-muted bg-white m-2">
                          <div className="w-12 h-12 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-3">
                            <i className="ph-fill ph-shield-check text-2xl text-green-500"></i>
                          </div>
                          <p className="font-medium text-gh-textBase">Dependabot is active and protecting this repository.</p>
                          <p className="text-xs mt-1">No vulnerable dependencies found.</p>
                        </div>
                      );
                    }

                    return (
                      <div key={alert.id} className="flex flex-col sm:flex-row sm:items-center justify-between px-3 py-2.5 hover:bg-gray-50 rounded-lg group transition-colors">
                        <div className="flex items-center gap-3">
                          <span className="text-gh-textBase font-mono text-sm">{alert.dependency}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border uppercase tracking-wider ${getSeverityColor(alert.severity)}`}>
                            {alert.severity}
                          </span>
                        </div>
                        
                        <div className="flex items-center gap-4 mt-2 sm:mt-0 text-sm">
                          {alert.cve && (
                            <span className="text-gh-muted text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white font-mono">
                              {alert.cve}
                            </span>
                          )}
                          <div className="flex items-center gap-2 text-xs">
                            <span className="text-red-600 font-mono bg-red-50 px-1.5 py-0.5 rounded">{alert.vulnerable_version}</span>
                            <i className="ph-bold ph-arrow-right text-gh-muted"></i>
                            <span className="text-green-600 font-mono bg-green-50 px-1.5 py-0.5 rounded">{alert.patched_version || 'No patch'}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-6 bg-white border border-gh-border rounded-xl px-5 py-3 shadow-sm">
            <span className="text-sm text-gh-muted">
              Showing {(currentPage - 1) * REPOS_PER_PAGE + 1}–{Math.min(currentPage * REPOS_PER_PAGE, allEntries.length)} of {allEntries.length} repositories
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setCurrentPage(1)}
                disabled={currentPage === 1}
                className="px-2 py-1 text-xs font-semibold rounded-md border border-gray-200 text-gh-muted hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <i className="ph-bold ph-caret-double-left"></i>
              </button>
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="px-2.5 py-1 text-xs font-semibold rounded-md border border-gray-200 text-gh-muted hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <i className="ph-bold ph-caret-left"></i>
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                .reduce<(number | "...")[]>((acc, p, i, arr) => {
                  if (i > 0 && p - (arr[i - 1]) > 1) acc.push("...");
                  acc.push(p);
                  return acc;
                }, [])
                .map((p, i) =>
                  p === "..." ? (
                    <span key={`e-${i}`} className="px-1.5 text-xs text-gray-400">...</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setCurrentPage(p as number)}
                      className={`w-8 h-8 text-xs font-bold rounded-md transition-colors ${
                        currentPage === p
                          ? "bg-gh-blue text-white"
                          : "border border-gray-200 text-gh-muted hover:bg-gray-50"
                      }`}
                    >
                      {p}
                    </button>
                  )
                )}
              <button
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="px-2.5 py-1 text-xs font-semibold rounded-md border border-gray-200 text-gh-muted hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <i className="ph-bold ph-caret-right"></i>
              </button>
              <button
                onClick={() => setCurrentPage(totalPages)}
                disabled={currentPage === totalPages}
                className="px-2 py-1 text-xs font-semibold rounded-md border border-gray-200 text-gh-muted hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <i className="ph-bold ph-caret-double-right"></i>
              </button>
            </div>
          </div>
        )}
            </>
          );
        })()}

      </main>
    </div>
  );
}