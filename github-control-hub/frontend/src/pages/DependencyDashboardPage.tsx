import React, { useState } from "react";
import { useDependencies, useDependencySummary } from "../hooks/useDependencies";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { DependencyAlert } from "../types/Dependabot";

export default function DependencyDashboardPage() {
  const { data: dependencies, isLoading: depsLoading } = useDependencies();
  const { data: summary, isLoading: sumLoading } = useDependencySummary();
  const { user } = useAuth();
  
  const [filterSeverity, setFilterSeverity] = useState<string>("all");

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
    if (filterSeverity !== "all" && dep.severity !== filterSeverity && !dep.disabled) return false;
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
        <div className="flex gap-2 mb-6 border-b border-gh-border pb-4">
          {["all", "critical", "high", "medium", "low"].map((sev) => (
            <button
              key={sev}
              onClick={() => setFilterSeverity(sev)}
              className={`px-4 py-1.5 text-sm font-semibold rounded-full capitalize transition-colors ${
                filterSeverity === sev
                  ? "bg-gh-blue text-white"
                  : "bg-white border border-gh-border text-gh-textMuted hover:text-gh-textBase"
              }`}
            >
              {sev}
            </button>
          ))}
        </div>

        {/* Repositories List */}
        <div className="space-y-6">
          {Object.keys(repoGroups).length === 0 ? (
            <div className="bg-white rounded-[12px] border border-gh-border p-12 text-center">
              <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <i className="ph-fill ph-check-circle text-3xl text-green-500"></i>
              </div>
              <h3 className="text-lg font-semibold text-gh-textBase">No vulnerabilities found</h3>
              <p className="text-gh-muted mt-1">Great job keeping dependencies up to date.</p>
            </div>
          ) : (
            Object.entries(repoGroups).map(([repoName, alerts]) => (
              <div key={repoName} className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
                <div className="bg-gray-50 px-5 py-3 border-b border-gh-border flex items-center gap-2">
                  <i className="ph ph-git-repository text-gh-muted"></i>
                  <h3 className="font-bold text-gh-textBase">{repoName}</h3>
                </div>
                
                <div className="p-2">
                  {alerts.map(alert => {
                    if (alert.disabled) {
                      return (
                        <div key={alert.id} className="px-3 py-3 flex items-center gap-3 text-sm text-gh-muted bg-gray-50 rounded-lg m-2 border border-gray-200 border-dashed">
                          <i className="ph-fill ph-warning-circle text-yellow-500 text-lg"></i>
                          <span>Dependabot alerts disabled</span>
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

      </main>
    </div>
  );
}