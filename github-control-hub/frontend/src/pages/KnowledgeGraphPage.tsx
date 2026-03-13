import { useState, useMemo } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import { useGraphNode, useBlastRadius, useBlastRadiusRanking } from "../hooks/useGraph";
import { useRepos } from "../hooks/useRepos";
import type { BlastRadiusRankingItem } from "../api/graph";

function riskColor(level: string) {
  switch (level) {
    case "CRITICAL": return { bg: "bg-rose-500", text: "text-white", ring: "ring-rose-300", light: "bg-rose-50 text-rose-700 border-rose-200" };
    case "HIGH": return { bg: "bg-orange-400", text: "text-white", ring: "ring-orange-300", light: "bg-orange-50 text-orange-700 border-orange-200" };
    case "MEDIUM": return { bg: "bg-amber-400", text: "text-white", ring: "ring-amber-300", light: "bg-amber-50 text-amber-700 border-amber-200" };
    default: return { bg: "bg-emerald-400", text: "text-white", ring: "ring-emerald-300", light: "bg-emerald-50 text-emerald-700 border-emerald-200" };
  }
}

function riskHex(level: string) {
  switch (level) {
    case "CRITICAL": return "#f43f5e";
    case "HIGH": return "#fb923c";
    case "MEDIUM": return "#fbbf24";
    default: return "#34d399";
  }
}

export default function KnowledgeGraphPage() {
  const { user } = useAuth();
  const { data: repos } = useRepos();
  const { data: ranking, isLoading: rankingLoading } = useBlastRadiusRanking();
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const rankingMap = useMemo(() => {
    const m = new Map<string, BlastRadiusRankingItem>();
    ranking?.forEach(r => m.set(r.repo, r));
    return m;
  }, [ranking]);

  const repoList = useMemo(() => {
    if (!repos) return [];
    return repos.map(r => ({
      name: r.name,
      ranking: rankingMap.get(r.name),
    })).sort((a, b) => {
      const sa = a.ranking?.score ?? -1;
      const sb = b.ranking?.score ?? -1;
      return sb - sa;
    });
  }, [repos, rankingMap]);

  const filtered = useMemo(() => {
    if (!search) return repoList;
    const q = search.toLowerCase();
    return repoList.filter(r => r.name.toLowerCase().includes(q));
  }, [repoList, search]);

  const stats = useMemo(() => {
    if (!ranking) return { critical: 0, high: 0, medium: 0, low: 0 };
    return {
      critical: ranking.filter(r => r.riskLevel === "CRITICAL").length,
      high: ranking.filter(r => r.riskLevel === "HIGH").length,
      medium: ranking.filter(r => r.riskLevel === "MEDIUM").length,
      low: ranking.filter(r => r.riskLevel === "LOW").length,
    };
  }, [ranking]);

  return (
    <div className="bg-slate-50 min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 animate-fade-in">
        <header className="flex flex-col md:flex-row md:items-end justify-between gap-6 mb-8">
          <div className="flex items-start gap-5">
            <div className="w-14 h-14 rounded-2xl bg-slate-900 text-white flex items-center justify-center shadow-lg shadow-slate-900/20 shrink-0">
              <i className="ph-fill ph-graph text-2xl"></i>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight mb-1">Knowledge Graph</h1>
              <p className="text-slate-500 text-sm max-w-lg leading-relaxed">
                Explore repository relationships and visualize organizational risk exposure across your GitHub organization.
              </p>
            </div>
          </div>
        </header>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Critical Risk", count: stats.critical, color: "rose", icon: "ph-warning-octagon" },
            { label: "High Risk", count: stats.high, color: "orange", icon: "ph-warning" },
            { label: "Medium Risk", count: stats.medium, color: "amber", icon: "ph-info" },
            { label: "Low Risk", count: stats.low, color: "emerald", icon: "ph-check-circle" },
          ].map(s => (
            <div key={s.label} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-xl bg-${s.color}-50 text-${s.color}-600 flex items-center justify-center shrink-0`}>
                <i className={`ph-fill ${s.icon} text-xl`}></i>
              </div>
              <div>
                <div className="text-2xl font-bold text-slate-900 font-mono">{s.count}</div>
                <div className="text-xs text-slate-500 font-medium">{s.label}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* Left: Heat Map */}
          <div className="flex-1">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-slate-900 text-sm flex items-center gap-2">
                    <i className="ph-fill ph-squares-four text-slate-400"></i>
                    Risk Heat Map
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">Click a repository to explore its relationships</p>
                </div>
                <div className="relative">
                  <i className="ph-bold ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
                  <input
                    type="text"
                    placeholder="Filter repositories..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 w-full sm:w-56"
                  />
                </div>
              </div>

              {rankingLoading ? (
                <div className="p-12 flex justify-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-600"></div>
                </div>
              ) : (
                <div className="p-5">
                  {/* Legend */}
                  <div className="flex items-center gap-4 mb-4 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">Risk Level:</span>
                    {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map(level => (
                      <span key={level} className="flex items-center gap-1.5">
                        <span className="w-3 h-3 rounded-sm" style={{ backgroundColor: riskHex(level) }}></span>
                        {level.charAt(0) + level.slice(1).toLowerCase()}
                      </span>
                    ))}
                  </div>

                  {/* Grid */}
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-2">
                    {filtered.map(r => {
                      const level = r.ranking?.riskLevel || "LOW";
                      const rc = riskColor(level);
                      const isSelected = selectedRepo === r.name;
                      return (
                        <button
                          key={r.name}
                          onClick={() => setSelectedRepo(isSelected ? null : r.name)}
                          className={`group relative rounded-xl p-3 text-left transition-all duration-200 border-2 ${
                            isSelected
                              ? `${rc.bg} ${rc.text} border-slate-900 shadow-lg scale-[1.03]`
                              : `bg-white border-slate-100 hover:border-slate-300 hover:shadow-md hover:-translate-y-0.5`
                          }`}
                        >
                          <div className={`w-2 h-2 rounded-full mb-2 ${isSelected ? 'bg-white/70' : rc.bg}`}></div>
                          <div className={`text-xs font-semibold truncate ${isSelected ? '' : 'text-slate-800'}`} title={r.name}>
                            {r.name}
                          </div>
                          <div className={`text-[10px] mt-1 font-mono ${isSelected ? 'opacity-80' : 'text-slate-400'}`}>
                            {r.ranking ? `${r.ranking.score} pts` : "—"}
                          </div>
                          {!isSelected && (
                            <div className={`absolute top-2 right-2 text-[9px] font-bold px-1.5 py-0.5 rounded border ${rc.light}`}>
                              {level.charAt(0)}
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {filtered.length === 0 && (
                    <div className="text-center py-12 text-slate-400">
                      <i className="ph-fill ph-magnifying-glass text-3xl mb-2 block"></i>
                      <p className="text-sm">No repositories match "{search}"</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right: Repo Explorer Panel */}
          <div className="w-full lg:w-[420px] shrink-0">
            {selectedRepo ? (
              <RepoExplorer repo={selectedRepo} ranking={rankingMap.get(selectedRepo)} onClose={() => setSelectedRepo(null)} />
            ) : (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-slate-50 text-slate-300 flex items-center justify-center mx-auto mb-4">
                  <i className="ph-fill ph-cursor-click text-3xl"></i>
                </div>
                <h3 className="font-semibold text-slate-700 mb-1">Select a Repository</h3>
                <p className="text-sm text-slate-500 leading-relaxed">
                  Click on any repository in the heat map to explore its branches, collaborators, teams, and security posture.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function RepoExplorer({ repo, ranking, onClose }: { repo: string; ranking?: BlastRadiusRankingItem; onClose: () => void }) {
  const { data: nodeData, isLoading: nodeLoading } = useGraphNode(`REPO#${repo}`);
  const { data: blastData, isLoading: blastLoading } = useBlastRadius(repo);

  const grouped = useMemo(() => {
    if (!nodeData) return { branches: [], collaborators: [], teams: [], workflows: [], dependencies: [], other: [] };
    const g = { branches: [] as any[], collaborators: [] as any[], teams: [] as any[], workflows: [] as any[], dependencies: [] as any[], other: [] as any[] };
    nodeData.edges.forEach(e => {
      if (e.target.startsWith("BRANCH#")) g.branches.push({ name: e.target.replace("BRANCH#", ""), protected: e.metadata?.protected });
      else if (e.target.startsWith("USER#")) g.collaborators.push({ name: e.target.replace("USER#", ""), role: e.metadata?.role || "read" });
      else if (e.target.startsWith("TEAM#")) g.teams.push({ name: e.target.replace("TEAM#", ""), permission: e.metadata?.permission });
      else if (e.target.startsWith("WORKFLOW#")) g.workflows.push({ name: e.target.replace("WORKFLOW#", "") });
      else if (e.target.startsWith("DEPENDENCY#")) g.dependencies.push({ name: e.target.replace("DEPENDENCY#", ""), severity: e.metadata?.severity });
      else g.other.push({ name: e.target, type: e.type });
    });
    g.branches.sort((a: any, b: any) => a.name.localeCompare(b.name));
    g.collaborators.sort((a: any, b: any) => {
      const order: Record<string, number> = { admin: 0, maintain: 1, write: 2, triage: 3, read: 4 };
      return (order[a.role] ?? 5) - (order[b.role] ?? 5);
    });
    return g;
  }, [nodeData]);

  const isLoading = nodeLoading || blastLoading;
  const level = ranking?.riskLevel || "LOW";
  const rc = riskColor(level);

  const sections: { key: string; label: string; icon: string; color: string; items: any[]; render: (item: any) => React.ReactNode }[] = [
    {
      key: "branches", label: "Branches", icon: "ph-git-branch", color: "blue",
      items: grouped.branches,
      render: (b) => (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-slate-700 font-mono truncate">{b.name}</span>
          {b.protected && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 font-medium shrink-0">Protected</span>}
        </div>
      ),
    },
    {
      key: "collaborators", label: "Collaborators", icon: "ph-user", color: "violet",
      items: grouped.collaborators,
      render: (c) => (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-slate-700">{c.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium shrink-0 ${
            ["admin", "write", "maintain"].includes(c.role)
              ? "bg-rose-50 text-rose-700 border-rose-200"
              : "bg-slate-50 text-slate-600 border-slate-200"
          }`}>{c.role}</span>
        </div>
      ),
    },
    {
      key: "teams", label: "Teams", icon: "ph-users-three", color: "purple",
      items: grouped.teams,
      render: (t) => (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-slate-700">{t.name}</span>
          {t.permission && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200 font-medium shrink-0">{t.permission}</span>}
        </div>
      ),
    },
    {
      key: "workflows", label: "Workflows", icon: "ph-gear-six", color: "teal",
      items: grouped.workflows,
      render: (w) => (
        <div className="py-1.5">
          <span className="text-sm text-slate-700 font-mono">{w.name}</span>
        </div>
      ),
    },
    {
      key: "dependencies", label: "Vulnerable Dependencies", icon: "ph-shield-warning", color: "rose",
      items: grouped.dependencies,
      render: (d) => (
        <div className="flex items-center justify-between py-1.5">
          <span className="text-sm text-slate-700 font-mono">{d.name}</span>
          {d.severity && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold uppercase shrink-0 ${
              d.severity === "critical" ? "bg-rose-50 text-rose-700 border-rose-200"
              : d.severity === "high" ? "bg-orange-50 text-orange-700 border-orange-200"
              : "bg-amber-50 text-amber-700 border-amber-200"
            }`}>{d.severity}</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden animate-scale-in flex flex-col max-h-[calc(100vh-160px)] sticky top-20">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className={`w-10 h-10 rounded-xl ${rc.bg} ${rc.text} flex items-center justify-center shrink-0 shadow-sm`}>
              <i className="ph-fill ph-git-repository text-lg"></i>
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900 truncate" title={repo}>{repo}</h3>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${rc.light}`}>{level}</span>
                {ranking && <span className="text-xs text-slate-400 font-mono">{ranking.score} pts</span>}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors p-1 -mr-1">
            <i className="ph-bold ph-x text-lg"></i>
          </button>
        </div>

        {/* Quick stats */}
        {!isLoading && (
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-white rounded-lg border border-slate-100 px-3 py-2 text-center">
              <div className="text-lg font-bold text-slate-900 font-mono">{grouped.branches.length}</div>
              <div className="text-[10px] text-slate-500 font-medium">Branches</div>
            </div>
            <div className="bg-white rounded-lg border border-slate-100 px-3 py-2 text-center">
              <div className="text-lg font-bold text-slate-900 font-mono">{grouped.collaborators.length}</div>
              <div className="text-[10px] text-slate-500 font-medium">People</div>
            </div>
            <div className="bg-white rounded-lg border border-slate-100 px-3 py-2 text-center">
              <div className="text-lg font-bold text-slate-900 font-mono">{grouped.dependencies.length}</div>
              <div className="text-[10px] text-slate-500 font-medium">Vulns</div>
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-8 flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 border-t-slate-600"></div>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {sections.map(section => section.items.length > 0 && (
              <CollapsibleSection
                key={section.key}
                label={section.label}
                icon={section.icon}
                color={section.color}
                count={section.items.length}
                defaultOpen={section.items.length <= 8}
              >
                {section.items.map((item, i) => (
                  <div key={i}>{section.render(item)}</div>
                ))}
              </CollapsibleSection>
            ))}

            {/* Blast radius summary */}
            {blastData && (blastData.workflows.length > 0 || blastData.teamsWithAccess.length > 0) && (
              <div className="px-5 py-4">
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
                  <i className="ph-fill ph-warning-octagon text-rose-500"></i>
                  Blast Radius
                </h4>
                <p className="text-xs text-slate-500 mb-3 leading-relaxed">
                  If <strong className="text-slate-700">{repo}</strong> is compromised, the following are at risk:
                </p>
                <div className="space-y-2">
                  {blastData.teamsWithAccess.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {blastData.teamsWithAccess.map(t => (
                        <span key={t.name} className="text-[11px] px-2 py-1 rounded-lg bg-purple-50 text-purple-700 border border-purple-200 font-medium">
                          {t.name} <span className="text-purple-400">({t.permission})</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {blastData.workflows.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {blastData.workflows.map(w => (
                        <span key={w} className="text-[11px] px-2 py-1 rounded-lg bg-teal-50 text-teal-700 border border-teal-200 font-mono">
                          {w}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {nodeData?.edges.length === 0 && (
              <div className="p-8 text-center text-slate-400">
                <i className="ph-fill ph-database text-3xl mb-2 block"></i>
                <p className="text-sm font-medium text-slate-500">No graph data for this repo</p>
                <p className="text-xs mt-1">Sync graph data from the Analytics page.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CollapsibleSection({ label, icon, color, count, defaultOpen, children }: {
  label: string; icon: string; color: string; count: number; defaultOpen: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const MAX_VISIBLE = 15;
  const [showAll, setShowAll] = useState(false);

  const childArray = Array.isArray(children) ? children : [children];
  const visible = showAll ? childArray : childArray.slice(0, MAX_VISIBLE);
  const hasMore = childArray.length > MAX_VISIBLE;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full px-5 py-3 flex items-center justify-between hover:bg-slate-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <i className={`ph-fill ${icon} text-${color}-500`}></i>
          <span className="text-sm font-semibold text-slate-700">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">{count}</span>
          <i className={`ph-bold ph-caret-${open ? 'up' : 'down'} text-xs text-slate-400`}></i>
        </div>
      </button>
      {open && (
        <div className="px-5 pb-3">
          <div className="divide-y divide-slate-50">
            {visible}
          </div>
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="mt-2 text-xs text-blue-600 hover:text-blue-700 font-medium"
            >
              Show all {count} ({count - MAX_VISIBLE} more)
            </button>
          )}
          {hasMore && showAll && (
            <button
              onClick={() => setShowAll(false)}
              className="mt-2 text-xs text-slate-500 hover:text-slate-700 font-medium"
            >
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}
