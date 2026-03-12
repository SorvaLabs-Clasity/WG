import React, { useState, useMemo } from "react";
import { useDependencies, useDependencySummary, useEnableDependabot, useDisableDependabot } from "../hooks/useDependencies";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { DependencyAlert } from "../types/Dependabot";

const SEVERITY_BADGE: Record<string, { bg: string; text: string; border: string; dot: string }> = {
  critical: { bg: "bg-rose-50", text: "text-rose-600", border: "border-rose-100", dot: "bg-rose-500" },
  high:     { bg: "bg-orange-50", text: "text-orange-600", border: "border-orange-100", dot: "bg-orange-500" },
  medium:   { bg: "bg-amber-50", text: "text-amber-600", border: "border-amber-100", dot: "bg-amber-500" },
  low:      { bg: "bg-blue-50", text: "text-blue-600", border: "border-blue-100", dot: "bg-blue-500" },
};

const STAT_CARDS: { key: string; label: string; borderColor: string; textColor: string; icon: string; pulse?: boolean }[] = [
  { key: "critical", label: "Critical", borderColor: "border-l-rose-500", textColor: "text-rose-600", icon: "fa-solid fa-skull-crossbones", pulse: true },
  { key: "high", label: "High", borderColor: "border-l-orange-500", textColor: "text-orange-600", icon: "fa-solid fa-fire" },
  { key: "medium", label: "Medium", borderColor: "border-l-amber-500", textColor: "text-amber-600", icon: "fa-solid fa-triangle-exclamation" },
  { key: "low", label: "Low", borderColor: "border-l-blue-500", textColor: "text-blue-600", icon: "fa-solid fa-info-circle" },
  { key: "repos_with_vulns", label: "Affected Repos", borderColor: "border-l-slate-400", textColor: "text-slate-800", icon: "fa-solid fa-code-branch" },
];

export default function DependencyDashboardPage() {
  const { data: dependencies, isLoading: depsLoading, isError: depsError, error: depsErrorObj } = useDependencies();
  const { data: summary, isLoading: sumLoading, isError: sumError } = useDependencySummary();
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
    try { await enableMutation.mutateAsync(repo); } finally { setLoadingRepo(null); }
  };

  const handleDisable = async (repo: string) => {
    if (!window.confirm(`Are you sure you want to disable Dependabot alerts for ${repo}?`)) return;
    setLoadingRepo(repo);
    try { await disableMutation.mutateAsync(repo); } finally { setLoadingRepo(null); }
  };

  const isLoading = depsLoading || sumLoading;

  if (isLoading) {
    return (
      <div className="bg-slate-50 text-slate-900 min-h-screen pt-14 antialiased">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-16 flex justify-center"><div className="animate-spin w-8 h-8 border-4 border-slate-300 border-t-slate-700 rounded-full"></div></div>
      </div>
    );
  }

  const rateLimited = depsError && (depsErrorObj as any)?.message?.includes("429");

  const repoGroups: Record<string, DependencyAlert[]> = {};
  const filteredDeps = (dependencies || []).filter(dep => {
    if (searchQuery) return dep.repo.toLowerCase().includes(searchQuery.toLowerCase());
    if (filterSeverity === "all-repos") return true;
    if (filterSeverity === "all-alerts") { if (dep.disabled || dep.clean) return false; }
    else { if (dep.disabled || dep.clean) return false; if (dep.severity !== filterSeverity) return false; }
    return true;
  });
  filteredDeps.forEach(dep => { if (!repoGroups[dep.repo]) repoGroups[dep.repo] = []; repoGroups[dep.repo].push(dep); });

  const allEntries = Object.entries(repoGroups);
  const totalPages = Math.ceil(allEntries.length / REPOS_PER_PAGE);
  const paginatedEntries = allEntries.slice((currentPage - 1) * REPOS_PER_PAGE, currentPage * REPOS_PER_PAGE);

  const criticalCountForRepo = (alerts: DependencyAlert[]) => alerts.filter(a => a.severity === "critical").length;

  return (
    <div className="bg-slate-50 text-slate-900 min-h-screen pt-14 antialiased">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-20">

        {/* Error Banner */}
        {(depsError || sumError) && (
          <div className="mb-6 px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm flex items-center gap-2">
            <i className="fa-solid fa-triangle-exclamation"></i>
            {rateLimited ? "GitHub API rate limit exceeded. Data will reload automatically when the limit resets." : "Failed to load dependency data. Please try refreshing."}
          </div>
        )}

        {/* Header */}
        <header className="flex items-start gap-5 mb-10">
          <div className="bg-slate-900 text-white w-14 h-14 rounded-2xl shadow-lg shadow-slate-900/10 flex items-center justify-center shrink-0">
            <i className="fa-solid fa-bug text-2xl"></i>
          </div>
          <div className="flex flex-col justify-center">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Dependency Security</h1>
            <p className="text-slate-500 text-sm mt-1 font-medium">Aggregate vulnerability data across all repositories using GitHub Dependabot alerts.</p>
          </div>
        </header>

        {/* Summary Stats */}
        {summary && (
          <section className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-10">
            {STAT_CARDS.map(card => {
              const val = (summary as any)[card.key] ?? 0;
              const isAffected = card.key === "repos_with_vulns";
              return (
                <div key={card.key} className={`relative rounded-2xl p-5 group hover:-translate-y-1 transition-all duration-300 border-l-4 ${card.borderColor} ${isAffected ? "bg-slate-50/80 border border-slate-200 shadow-sm" : "bg-white shadow-soft"}`}>
                  <div className="absolute top-4 right-4 text-slate-200 text-xl opacity-50 group-hover:opacity-100 transition-opacity">
                    <i className={card.icon}></i>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className={`text-3xl font-bold ${card.textColor} block mb-1`}>{val}</span>
                    {card.pulse && val > 0 && <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse"></span>}
                  </div>
                  <div className={`text-[10px] font-bold uppercase tracking-wider ${isAffected ? "text-slate-500" : "text-slate-400"}`}>{card.label}</div>
                </div>
              );
            })}
          </section>
        )}

        {/* Filter / Search */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
          <div className="bg-white rounded-lg border border-slate-200 p-1 shadow-sm inline-flex overflow-x-auto max-w-full">
            {[
              { id: "all-alerts", label: "All Alerts" },
              { id: "all-repos", label: "All Repos" },
              { id: "critical", label: "Critical" },
              { id: "high", label: "High" },
              { id: "medium", label: "Medium" },
              { id: "low", label: "Low" },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => { setFilterSeverity(f.id); setCurrentPage(1); }}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all flex items-center gap-2 whitespace-nowrap ${filterSeverity === f.id ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"}`}
              >
                {SEVERITY_BADGE[f.id] && <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_BADGE[f.id].dot}`}></span>}
                {f.label}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-80">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <i className="fa-solid fa-magnifying-glass text-slate-400 text-sm"></i>
            </div>
            <input
              type="text" value={searchQuery} onChange={e => { setSearchQuery(e.target.value); setCurrentPage(1); }}
              className="block w-full pl-10 pr-3 py-2 border border-slate-200 rounded-lg bg-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900 focus:border-transparent text-sm shadow-sm transition-all"
              placeholder="Search repositories..."
            />
          </div>
        </div>

        {/* Repo List */}
        <div className="space-y-6">
          {allEntries.length === 0 ? (
            <div className="py-20 flex flex-col items-center justify-center text-center animate-fade-in">
              <div className="w-24 h-24 bg-emerald-50 rounded-full flex items-center justify-center mb-6">
                <i className="fa-solid fa-shield-check text-4xl text-emerald-400"></i>
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">No vulnerabilities found</h3>
              <p className="text-slate-500">Great job keeping dependencies up to date.</p>
            </div>
          ) : (
            paginatedEntries.map(([repoName, alerts]) => {
              const isDisabled = alerts[0]?.disabled;
              const isClean = alerts[0]?.clean;
              const critCount = criticalCountForRepo(alerts);

              return (
                <div key={repoName} className={`bg-white rounded-2xl border border-slate-100 shadow-soft overflow-hidden transition-shadow duration-300 ${isDisabled ? "opacity-90 hover:opacity-100" : "hover:shadow-lg"}`}>
                  {/* Repo Header */}
                  <div className={`px-6 py-4 border-b border-slate-100 flex items-center justify-between ${isClean ? "bg-gradient-to-r from-emerald-50/30 to-white" : isDisabled ? "bg-slate-50" : "bg-gradient-to-r from-slate-50 via-white to-white"}`}>
                    <div className="flex items-center gap-3">
                      <i className="fa-solid fa-book-bookmark text-slate-400 text-lg"></i>
                      <span className={`font-bold text-lg ${isDisabled ? "text-slate-600" : "text-slate-800"}`}>{repoName}</span>
                      {critCount > 0 && (
                        <span className="bg-rose-50 text-rose-700 text-[10px] font-bold px-2 py-0.5 rounded-full border border-rose-100 uppercase tracking-wide">{critCount} Critical</span>
                      )}
                      {isClean && (
                        <span className="bg-emerald-50 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-100 uppercase tracking-wide">Secure</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {alerts[0]?.org && !isDisabled && (
                        <a
                          href={`https://github.com/${alerts[0].org}/${repoName}/security/dependabot`}
                          target="_blank" rel="noreferrer"
                          className="flex items-center gap-1.5 bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-300 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors"
                        >
                          <i className="fa-solid fa-up-right-from-square"></i> View in GitHub
                        </a>
                      )}
                      {!isDisabled && !isClean && (
                        <button
                          onClick={() => handleDisable(repoName)}
                          disabled={loadingRepo === repoName}
                          className="flex items-center gap-1.5 bg-white border border-rose-200 text-rose-500 hover:text-rose-700 hover:border-rose-300 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50"
                        >
                          {loadingRepo === repoName ? <div className="animate-spin w-3 h-3 border-2 border-rose-500 border-t-transparent rounded-full"></div> : <i className="fa-solid fa-shield-halved"></i>}
                          Disable
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Body */}
                  {isDisabled ? (
                    <div className="p-6">
                      <div className="border-2 border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-6 flex flex-col md:flex-row items-center justify-between gap-4">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-500 shrink-0">
                            <i className="fa-solid fa-triangle-exclamation"></i>
                          </div>
                          <div>
                            <p className="text-slate-800 font-bold text-sm">Dependabot alerts disabled</p>
                            <p className="text-slate-500 text-xs mt-0.5">Enable alerts to scan for vulnerabilities.</p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleEnable(repoName)}
                          disabled={loadingRepo === repoName}
                          className="bg-white border border-slate-200 text-slate-700 hover:text-slate-900 hover:border-slate-300 shadow-sm rounded-lg px-4 py-2 text-xs font-bold uppercase tracking-wide transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                          {loadingRepo === repoName && <div className="animate-spin w-3 h-3 border-2 border-slate-600 border-t-transparent rounded-full"></div>}
                          Enable Alerts
                        </button>
                      </div>
                    </div>
                  ) : isClean ? (
                    <div className="p-8 flex flex-col items-center justify-center text-center">
                      <div className="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center text-emerald-500 mb-3">
                        <i className="fa-solid fa-shield-check text-xl"></i>
                      </div>
                      <h3 className="text-slate-800 font-bold text-sm">No vulnerable dependencies found</h3>
                      <p className="text-slate-400 text-xs mt-1">Dependabot is active and protecting this repository.</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-50">
                      {alerts.map(alert => {
                        const sev = SEVERITY_BADGE[alert.severity] || SEVERITY_BADGE.low;
                        return (
                          <div key={alert.id} className="px-6 py-4 flex flex-col md:flex-row md:items-center justify-between hover:bg-slate-50 transition-colors">
                            <div className="flex items-center gap-3 mb-2 md:mb-0">
                              <span className="font-mono text-sm font-semibold text-slate-700">{alert.dependency}</span>
                              <span className={`text-[10px] font-bold ${sev.bg} ${sev.text} border ${sev.border} px-2 py-0.5 rounded-full uppercase tracking-wider`}>
                                {alert.severity}
                              </span>
                            </div>
                            <div className="flex items-center gap-4 text-sm">
                              {alert.cve && (
                                <span className="bg-slate-50 border border-slate-200 text-slate-500 rounded-md px-2 py-1 font-mono text-[11px]">{alert.cve}</span>
                              )}
                              <div className="flex items-center gap-2 font-mono text-xs">
                                <span className="text-rose-600 bg-rose-50 px-2 py-1 rounded border border-rose-100">{alert.vulnerable_version}</span>
                                <i className="fa-solid fa-arrow-right text-slate-300 text-[10px]"></i>
                                <span className={`px-2 py-1 rounded border ${alert.patched_version ? "text-emerald-600 bg-emerald-50 border-emerald-100" : "text-slate-400 bg-slate-50 border-slate-200"}`}>
                                  {alert.patched_version || "No patch"}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="mt-10 bg-white rounded-xl border border-slate-200 shadow-sm px-5 py-3 flex flex-col md:flex-row items-center justify-between gap-4">
            <span className="text-sm text-slate-500 font-mono font-medium">
              Showing <span className="text-slate-900">{(currentPage - 1) * REPOS_PER_PAGE + 1}-{Math.min(currentPage * REPOS_PER_PAGE, allEntries.length)}</span> of <span className="text-slate-900">{allEntries.length}</span> repositories
            </span>
            <nav className="flex items-center gap-1">
              <button onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className="w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 text-slate-400 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <i className="fa-solid fa-angles-left text-xs"></i>
              </button>
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 text-slate-400 bg-white hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <i className="fa-solid fa-chevron-left text-xs"></i>
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
                    <span key={`e-${i}`} className="px-2 text-slate-400 text-xs">...</span>
                  ) : (
                    <button key={p} onClick={() => setCurrentPage(p as number)} className={`w-8 h-8 flex items-center justify-center rounded-md font-medium text-xs transition-colors ${currentPage === p ? "bg-slate-900 text-white font-bold shadow-sm shadow-slate-900/20" : "border border-slate-200 text-slate-500 hover:bg-slate-50 bg-white"}`}>
                      {p}
                    </button>
                  )
                )}
              <button onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <i className="fa-solid fa-chevron-right text-xs"></i>
              </button>
              <button onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className="w-8 h-8 flex items-center justify-center rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 bg-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <i className="fa-solid fa-angles-right text-xs"></i>
              </button>
            </nav>
          </div>
        )}

      </main>
    </div>
  );
}
