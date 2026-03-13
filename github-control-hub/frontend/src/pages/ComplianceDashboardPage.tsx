import React, { useState, useEffect, useMemo } from "react";
import { useComplianceDashboard, useComplianceConfig, useUpdateComplianceConfig, useRefreshCompliance } from "../hooks/useCompliance";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import type { ComplianceRule, RepoComplianceScore } from "../types/Compliance";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import { TagInput } from "../components/TagInput";

const RULE_TYPE_LABELS: Record<string, string> = {
  branch_protection: "Branch Protection",
  tag_protection: "Tag Protection",
  rulesets: "Active Rulesets",
  required_files: "Required Files",
  outside_collaborators: "Outside Collaborators",
  query: "Security Query",
  codeowners: "CODEOWNERS",
};

const RULE_TYPE_ICONS: Record<string, string> = {
  branch_protection: "fa-solid fa-shield-halved",
  tag_protection: "fa-solid fa-tag",
  rulesets: "fa-solid fa-list-check",
  required_files: "fa-solid fa-file-lines",
  outside_collaborators: "fa-solid fa-user-group",
  query: "fa-solid fa-magnifying-glass-chart",
  codeowners: "fa-solid fa-people-group",
};

const RULE_ICON_COLORS: Record<string, { bg: string; text: string }> = {
  branch_protection: { bg: "bg-blue-50 dark:bg-blue-950/50", text: "text-blue-600 dark:text-blue-400" },
  tag_protection: { bg: "bg-teal-50 dark:bg-teal-950/50", text: "text-teal-600 dark:text-teal-400" },
  rulesets: { bg: "bg-indigo-50 dark:bg-indigo-950/50", text: "text-indigo-600 dark:text-indigo-400" },
  required_files: { bg: "bg-cyan-50 dark:bg-cyan-950/50", text: "text-cyan-600 dark:text-cyan-400" },
  outside_collaborators: { bg: "bg-amber-50 dark:bg-amber-950/50", text: "text-amber-600 dark:text-amber-400" },
  query: { bg: "bg-violet-50 dark:bg-violet-950/50", text: "text-violet-600 dark:text-violet-400" },
  codeowners: { bg: "bg-purple-50 dark:bg-purple-950/50", text: "text-purple-600 dark:text-purple-400" },
};

function newId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function scoreColor(score: number) {
  if (score >= 90) return { hex: "#10b981", text: "text-emerald-600 dark:text-emerald-400", bg: "bg-emerald-50 dark:bg-emerald-950/50", border: "border-emerald-200 dark:border-emerald-700" };
  if (score >= 70) return { hex: "#f59e0b", text: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/50", border: "border-amber-200 dark:border-amber-700" };
  return { hex: "#f43f5e", text: "text-rose-600 dark:text-rose-400", bg: "bg-rose-50 dark:bg-rose-950/50", border: "border-rose-200 dark:border-rose-700" };
}

function Gauge({ score, size = 48, textClass = "text-xs" }: { score: number; size?: number; textClass?: string }) {
  const { hex, text } = scoreColor(score);
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div
      className={`gauge-ring ${size >= 72 ? "gauge-ring-lg" : ""} flex-shrink-0 flex items-center justify-center`}
      style={{ width: size, height: size, "--gauge-color": hex, "--gauge-pct": `${pct}%` } as React.CSSProperties}
    >
      <span className={`relative z-10 font-bold font-mono ${textClass} ${text}`}>{score < 0 ? "—" : score}</span>
    </div>
  );
}

export default function ComplianceDashboardPage() {
  const { data: scores, isLoading, isError: scoresError } = useComplianceDashboard();
  const { data: configData, isLoading: configLoading } = useComplianceConfig();
  const updateConfigMutation = useUpdateComplianceConfig();
  const refreshMutation = useRefreshCompliance();
  const { user } = useAuth();

  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<"score-asc" | "score-desc" | "name">("score-asc");
  const [statusFilter, setStatusFilter] = useState<"all" | "passing" | "failing">("all");
  const [ruleFilter, setRuleFilter] = useState<{ ruleId: string; status: "passing" | "failing" } | null>(null);

  const [rulesOpen, setRulesOpen] = useState(false);
  const [detailRepo, setDetailRepo] = useState<RepoComplianceScore | null>(null);
  const [rules, setRules] = useState<(ComplianceRule & { fileInputVal?: string; hasPendingBranch?: boolean })[]>([]);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  useEffect(() => {
    if (configData?.rules) setRules(configData.rules.map(r => ({ ...r, fileInputVal: "", hasPendingBranch: false })));
  }, [configData]);

  useEffect(() => { if (snack) { const t = setTimeout(() => setSnack(null), 4000); return () => clearTimeout(t); } }, [snack]);

  const handleSave = () => {
    if (rules.some(r => r.hasPendingBranch)) return;
    const cleaned = rules.map(({ fileInputVal, hasPendingBranch, ...rest }) => rest);
    updateConfigMutation.mutate({ rules: cleaned }, {
      onSuccess: () => { setSnack({ msg: "Requirements saved", severity: "success" }); },
      onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
    });
  };

  const addRule = (type: ComplianceRule["type"]) => {
    const base: ComplianceRule = { id: newId(), name: RULE_TYPE_LABELS[type] || "New Rule", enabled: true, weight: 10, type };
    if (type === "branch_protection") { base.branchName = "__default__"; base.protectionType = "any"; }
    if (type === "tag_protection") base.tagPatterns = ["v*"];
    if (type === "required_files") base.requiredFiles = ["README.md"];
    if (type === "outside_collaborators") base.maxOutsideCollaborators = 0;
    if (type === "query") base.queryId = QUERY_OPTIONS[0].id;
    if (type === "codeowners") base.codeownersRequireEntries = [];
    setRules([...rules, { ...base, fileInputVal: "" }]);
  };

  const removeRule = (idx: number) => setRules(rules.filter((_, i) => i !== idx));
  const updateRule = (idx: number, patch: Partial<ComplianceRule & { fileInputVal?: string }>) => setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const updateRuleField = (idx: number, field: string, val: unknown) => setRules(rules.map((r, i) => (i === idx ? { ...r, [field]: val } : r)));
  const updateRuleRules = (idx: number, field: string, val: unknown) => setRules(rules.map((r, i) => (i === idx ? { ...r, rules: { ...r.rules, [field]: val } } : r)));

  const validScores = useMemo(() => (scores || []).filter(s => s.score >= 0), [scores]);
  const totalRepos = validScores.length;
  const avgScore = totalRepos > 0 ? Math.round(validScores.reduce((a, s) => a + s.score, 0) / totalRepos) : 0;
  const passing = validScores.filter(s => s.score >= 90).length;
  const failing = totalRepos - passing;

  const lastChecked = useMemo(() => {
    if (!validScores.length) return null;
    const latest = validScores.reduce((l, s) => (s.lastChecked > l ? s.lastChecked : l), validScores[0].lastChecked);
    return new Date(latest);
  }, [validScores]);

  const uniqueRules = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of (scores || [])) {
      for (const r of (s.ruleResults || [])) {
        if (!map.has(r.ruleId)) map.set(r.ruleId, r.ruleName);
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name }));
  }, [scores]);

  const filtered = useMemo(() => {
    let list = [...(scores || [])].filter(s => s.score >= 0);
    if (searchTerm) list = list.filter(s => s.repo.toLowerCase().includes(searchTerm.toLowerCase()));
    if (statusFilter === "passing") list = list.filter(s => s.score >= 90);
    if (statusFilter === "failing") list = list.filter(s => s.score < 90);
    if (ruleFilter) {
      list = list.filter(s => {
        const match = (s.ruleResults || []).find(r => r.ruleId === ruleFilter.ruleId);
        if (!match) return false;
        return ruleFilter.status === "passing" ? match.passed : !match.passed;
      });
    }
    if (sortBy === "score-asc") list.sort((a, b) => a.score - b.score);
    else if (sortBy === "score-desc") list.sort((a, b) => b.score - a.score);
    else list.sort((a, b) => a.repo.localeCompare(b.repo));
    return list;
  }, [scores, searchTerm, statusFilter, sortBy, ruleFilter]);

  if (isLoading || configLoading) {
    return (
      <div className="bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-12 flex justify-center"><div className="animate-spin w-8 h-8 border-4 border-slate-300 dark:border-slate-600 border-t-slate-700 dark:border-t-slate-300 rounded-full"></div></div>
      </div>
    );
  }

  const totalWeight = rules.filter(r => r.enabled).reduce((s, r) => s + (r.weight || 0), 0);
  const weightValid = totalWeight === 100;

  return (
    <div className="bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-200 min-h-screen pt-14 antialiased">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8">

        {/* --- HEADER --- */}
        <header className="mb-10">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h1 className="text-2xl font-bold text-slate-900 dark:text-white tracking-tight flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-slate-900 dark:bg-slate-700 text-white flex items-center justify-center shadow-lg"><i className="fa-solid fa-shield-halved text-lg"></i></div>
                Compliance Dashboard
              </h1>
              <p className="text-slate-500 dark:text-slate-400 text-sm mt-1 ml-[52px]">
                {lastChecked ? <>Last sync: <span className="font-mono text-slate-600 dark:text-slate-400">{lastChecked.toLocaleString()}</span></> : "No data yet"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => refreshMutation.mutate()}
                disabled={refreshMutation.isPending}
                className="group h-10 px-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 rounded-lg hover:border-slate-300 dark:hover:border-slate-600 hover:text-slate-900 dark:hover:text-white hover:shadow-soft transition-all flex items-center gap-2 disabled:opacity-50"
              >
                <i className={`fa-solid fa-arrows-rotate transition-transform ${refreshMutation.isPending ? "animate-spin" : "group-hover:rotate-180"}`}></i>
                <span className="font-medium text-sm">{refreshMutation.isPending ? "Syncing..." : "Sync"}</span>
              </button>
              <button
                onClick={() => setRulesOpen(true)}
                className="h-10 px-5 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-lg shadow-lg shadow-slate-900/20 hover:bg-slate-800 dark:hover:bg-slate-200 transition-all flex items-center gap-2"
              >
                <i className="fa-solid fa-sliders"></i>
                <span className="font-medium text-sm">Configure Rules</span>
              </button>
            </div>
          </div>

          {scoresError && (
            <div className="mt-4 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-200 text-sm flex items-center gap-2">
              <i className="fa-solid fa-triangle-exclamation"></i>
              Failed to load compliance data. Click Sync to try again.
            </div>
          )}

          {/* --- STATS --- */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-8">
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 shadow-soft border border-slate-100 dark:border-slate-700 flex items-center justify-between">
              <div>
                <p className="text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Total Repositories</p>
                <p className="text-4xl font-bold text-slate-800 dark:text-slate-200">{totalRepos}</p>
              </div>
              <div className="w-12 h-12 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500"><i className="fa-solid fa-code-branch text-xl"></i></div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 shadow-soft border border-slate-100 dark:border-slate-700 flex items-center gap-4 relative overflow-hidden">
              <div className="absolute right-0 top-0 w-24 h-24 bg-gradient-to-br from-emerald-50 dark:from-emerald-950/50 to-transparent rounded-bl-full opacity-50"></div>
              <Gauge score={avgScore} size={76} textClass="text-xl" />
              <div>
                <p className="text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Org Health</p>
                <p className={`text-sm font-medium ${scoreColor(avgScore).text}`}>Weighted Average</p>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 shadow-soft border border-slate-100 dark:border-slate-700 flex flex-col justify-center border-l-4 border-l-emerald-400">
              <p className="text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Compliant</p>
              <div className="flex items-end gap-2">
                <p className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">{passing}</p>
                <span className="text-sm text-slate-400 dark:text-slate-500 mb-1 font-medium">/ {totalRepos}</span>
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 rounded-2xl p-6 shadow-soft border border-slate-100 dark:border-slate-700 flex flex-col justify-center border-l-4 border-l-rose-400">
              <p className="text-slate-400 dark:text-slate-500 text-xs font-bold uppercase tracking-wider mb-1">Action Required</p>
              <div className="flex items-end gap-2">
                <p className="text-3xl font-bold text-rose-600 dark:text-rose-400">{failing}</p>
                <span className="text-sm text-slate-400 dark:text-slate-500 mb-1 font-medium">repos</span>
              </div>
            </div>
          </div>
        </header>

        {/* --- FILTER BAR --- */}
        <div className="flex flex-col sm:flex-row gap-4 mb-6">
          <div className="relative flex-grow max-w-lg">
            <i className="fa-solid fa-magnifying-glass absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"></i>
            <input
              type="text" placeholder="Search repositories..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              className="w-full h-11 pl-11 pr-4 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-slate-400/30 focus:border-slate-400 shadow-sm transition-all placeholder:dark:text-slate-500"
            />
          </div>
          <div className="flex gap-2">
            <select value={sortBy} onChange={e => setSortBy(e.target.value as any)} className="h-11 pl-3 pr-8 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-200 focus:outline-none shadow-sm cursor-pointer">
              <option value="score-asc">Lowest Score First</option>
              <option value="score-desc">Highest Score First</option>
              <option value="name">Name (A-Z)</option>
            </select>
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-1 flex h-11 shadow-sm">
              {(["all", "passing", "failing"] as const).map(f => (
                <button key={f} onClick={() => setStatusFilter(f)} className={`px-4 h-full rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${statusFilter === f ? (f === "passing" ? "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 shadow-inner" : f === "failing" ? "bg-rose-100 dark:bg-rose-900/50 text-rose-700 dark:text-rose-300 shadow-inner" : "bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 shadow-inner") : "text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800"}`}>
                  {f === "all" ? "All" : f === "passing" ? "Pass" : "Fail"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* --- RULE CONDITION FILTER --- */}
        {uniqueRules.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mr-1">Filter by rule:</span>
            {uniqueRules.map(r => {
              const isActivePass = ruleFilter?.ruleId === r.id && ruleFilter.status === "passing";
              const isActiveFail = ruleFilter?.ruleId === r.id && ruleFilter.status === "failing";
              const isActive = isActivePass || isActiveFail;
              return (
                <div key={r.id} className="flex items-center">
                  <button
                    onClick={() => {
                      if (isActivePass) setRuleFilter({ ruleId: r.id, status: "failing" });
                      else if (isActiveFail) setRuleFilter(null);
                      else setRuleFilter({ ruleId: r.id, status: "passing" });
                    }}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-all flex items-center gap-1.5 ${
                      isActivePass
                        ? "bg-emerald-50 dark:bg-emerald-950/50 border-emerald-300 dark:border-emerald-600 text-emerald-700 dark:text-emerald-300"
                        : isActiveFail
                          ? "bg-rose-50 dark:bg-rose-950/50 border-rose-300 dark:border-rose-600 text-rose-700 dark:text-rose-300"
                          : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800"
                    }`}
                  >
                    {isActive && (
                      <i className={`fa-solid ${isActivePass ? "fa-circle-check text-emerald-500" : "fa-circle-xmark text-rose-500"} text-[10px]`}></i>
                    )}
                    {r.name}
                    {isActive && (
                      <span className="text-[10px] opacity-70">
                        {isActivePass ? "passing" : "failing"}
                      </span>
                    )}
                  </button>
                </div>
              );
            })}
            {ruleFilter && (
              <button
                onClick={() => setRuleFilter(null)}
                className="text-[11px] text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors flex items-center gap-1 ml-1"
              >
                <i className="fa-solid fa-xmark text-[10px]"></i>
                Clear
              </button>
            )}
          </div>
        )}

        {/* --- REPO GRID --- */}
        {filtered.length === 0 ? (
          <div className="py-20 text-center">
            <div className="w-24 h-24 bg-slate-100 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-6"><i className="fa-solid fa-shield-halved text-4xl text-slate-300 dark:text-slate-600"></i></div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mb-2">
              {scores && scores.length === 0 ? "No compliance data yet" : "No repositories match"}
            </h3>
            <p className="text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              {scores && scores.length === 0 ? 'Click "Sync" to run the first compliance check.' : "Try adjusting your search or filters."}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 pb-20">
            {filtered.map(repo => (
              <div key={repo.repo} onClick={() => setDetailRepo(repo)} className="bg-white dark:bg-slate-900 rounded-2xl p-5 shadow-sm border border-slate-200 dark:border-slate-700 hover:shadow-soft hover:-translate-y-1 transition-all duration-300 cursor-pointer group">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-500 dark:text-slate-400 group-hover:bg-blue-50 dark:group-hover:bg-blue-950/50 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                      <i className="fa-regular fa-folder-open text-lg"></i>
                    </div>
                    <div>
                      <h3 className="font-bold text-slate-800 dark:text-slate-200 text-lg leading-tight group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{repo.repo}</h3>
                    </div>
                  </div>
                  <Gauge score={repo.score} />
                </div>

                <div className="flex items-center gap-4 mb-4 pl-1">
                  <div className="flex items-center -space-x-1">
                    {(repo.ruleResults || []).slice(0, 4).map((r, i) => (
                      <div key={i} title={r.ruleName} className={`w-6 h-6 rounded-full flex items-center justify-center ${r.passed ? "bg-emerald-50 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-700" : "bg-rose-50 dark:bg-rose-950/50 text-rose-500 dark:text-rose-400 border-rose-200 dark:border-rose-700"} border`}>
                        <i className={`fa-solid ${r.passed ? "fa-check" : "fa-xmark"} text-[10px]`}></i>
                      </div>
                    ))}
                    {(repo.ruleResults || []).length > 4 && (
                      <span className="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] text-slate-500 dark:text-slate-400 font-bold border border-slate-200 dark:border-slate-700">+{(repo.ruleResults || []).length - 4}</span>
                    )}
                  </div>
                  <div className="h-4 w-[1px] bg-slate-200 dark:bg-slate-700"></div>
                  <div className={`flex items-center gap-1.5 text-xs font-medium ${repo.outsideCollaborators > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-400 dark:text-slate-500"}`}>
                    <i className="fa-solid fa-users"></i>
                    {repo.outsideCollaborators} External
                  </div>
                </div>

                {repo.issues.length > 0 ? (
                  <div className="bg-rose-50 dark:bg-rose-950/50 rounded-lg px-3 py-2 flex items-center gap-2 border border-rose-100 dark:border-rose-700">
                    <i className="fa-solid fa-triangle-exclamation text-rose-500 dark:text-rose-400 text-xs"></i>
                    <span className="text-xs text-rose-700 dark:text-rose-300 font-medium">{repo.issues.length} Issue{repo.issues.length !== 1 ? "s" : ""} Detected</span>
                  </div>
                ) : (
                  <div className="bg-emerald-50 dark:bg-emerald-950/50 rounded-lg px-3 py-2 flex items-center gap-2 border border-emerald-100 dark:border-emerald-700">
                    <i className="fa-solid fa-shield-halved text-emerald-500 dark:text-emerald-400 text-xs"></i>
                    <span className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">Policy Compliant</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* --- SLIDE-OUT RULES PANEL --- */}
      {rulesOpen && (
        <div className="fixed inset-0 z-50">
          <div onClick={() => setRulesOpen(false)} className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm animate-fade-in"></div>
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-xl bg-white dark:bg-slate-900 shadow-2xl animate-slide-in-right flex flex-col border-l border-slate-100 dark:border-slate-700">
            {/* Header */}
            <div className="px-6 py-5 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center gap-2"><i className="fa-solid fa-sliders text-slate-500 dark:text-slate-400"></i> Rule Configuration</h2>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Define weighted criteria for compliance scores.</p>
              </div>
              <div className="flex items-center gap-3">
                <div className={`px-3 py-1.5 rounded-md border flex items-center gap-2 text-xs ${weightValid ? "bg-emerald-50 dark:bg-emerald-950/50 border-emerald-200 dark:border-emerald-700" : "bg-rose-50 dark:bg-rose-950/50 border-rose-200 dark:border-rose-700"}`}>
                  <span className="font-bold uppercase text-slate-400 dark:text-slate-500">Weight</span>
                  <span className={`font-mono font-bold ${weightValid ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{totalWeight}/100</span>
                  <div className={`w-2 h-2 rounded-full ${weightValid ? "bg-emerald-500" : "bg-rose-500"}`}></div>
                </div>
                <button onClick={() => setRulesOpen(false)} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"><i className="fa-solid fa-xmark text-xl"></i></button>
              </div>
            </div>

            {/* Scrollable body */}
            <div className="flex-1 overflow-y-auto p-6 bg-slate-50 dark:bg-slate-950 space-y-3">
              {rules.map((rule, idx) => (
                <RuleCard key={rule.id} rule={rule}
                  onToggle={() => updateRuleField(idx, "enabled", !rule.enabled)}
                  onRemove={() => removeRule(idx)}
                  onUpdate={p => updateRule(idx, p)}
                  onUpdateField={(f, v) => updateRuleField(idx, f, v)}
                  onUpdateRules={(f, v) => updateRuleRules(idx, f, v)}
                />
              ))}
              {rules.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-6">No rules configured. Add one below.</p>}
            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <p className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-3">Add Rule</p>
              <div className="grid grid-cols-3 gap-3">
                {(["branch_protection", "tag_protection", "rulesets", "required_files", "outside_collaborators", "codeowners", "query"] as const).map(t => (
                  <button key={t} onClick={() => addRule(t)} className="p-3 border border-dashed border-slate-300 dark:border-slate-600 rounded-lg text-slate-500 dark:text-slate-400 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 flex flex-col items-center gap-1 transition-colors">
                    <i className={`${RULE_TYPE_ICONS[t]} text-lg`}></i>
                    <span className="text-[10px] font-bold">{RULE_TYPE_LABELS[t]}</span>
                  </button>
                ))}
              </div>
              <button
                onClick={handleSave}
                disabled={updateConfigMutation.isPending || !weightValid || rules.some(r => r.hasPendingBranch)}
                className="w-full mt-6 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 font-bold h-12 rounded-lg hover:bg-slate-800 dark:hover:bg-slate-200 transition-colors shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updateConfigMutation.isPending ? "Saving..." : "Save Configuration"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- REPO DETAIL MODAL --- */}
      {detailRepo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fade-in">
          <div onClick={() => setDetailRepo(null)} className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"></div>
          <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-2xl shadow-2xl relative z-20 overflow-hidden animate-scale-in flex flex-col max-h-[90vh]">
            {/* Header */}
            <div className="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 bg-slate-100 dark:bg-slate-800 rounded-md"><i className="fa-regular fa-folder-open text-slate-500 dark:text-slate-400"></i></div>
                  <h2 className="text-2xl font-bold text-slate-900 dark:text-white">{detailRepo.repo}</h2>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 flex items-center gap-2">
                  <i className="fa-regular fa-clock"></i> Last checked: <span className="font-mono text-slate-700 dark:text-slate-300">{new Date(detailRepo.lastChecked).toLocaleString()}</span>
                </p>
              </div>
              <Gauge score={detailRepo.score} size={64} textClass="text-lg" />
              <button onClick={() => setDetailRepo(null)} className="absolute top-4 right-4 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"><i className="fa-solid fa-xmark text-xl"></i></button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto p-6 space-y-6">
              <div>
                <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Compliance Checks</h3>
                <div className="space-y-2">
                  {(detailRepo.ruleResults || []).map((r, i) => (
                    <div key={i} className={`flex items-start gap-4 p-3 rounded-lg border ${r.passed ? "bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-700" : "bg-rose-50/50 dark:bg-rose-950/30 border-rose-100 dark:border-rose-700"}`}>
                      <div className={`mt-0.5 ${r.passed ? "text-emerald-500" : "text-rose-500"}`}><i className={`fa-solid ${r.passed ? "fa-circle-check" : "fa-circle-xmark"}`}></i></div>
                      <div>
                        <p className="text-sm font-bold text-slate-800 dark:text-slate-200">{r.ruleName}</p>
                        {r.detail && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{r.detail}</p>}
                      </div>
                    </div>
                  ))}
                  {(!detailRepo.ruleResults || detailRepo.ruleResults.length === 0) && (
                    <p className="text-sm text-slate-500 dark:text-slate-400 text-center py-4">No rule results available.</p>
                  )}
                </div>
              </div>

              <div>
                <h3 className="text-xs font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-3">Issues</h3>
                {detailRepo.issues.length === 0 ? (
                  <div className="p-3 bg-emerald-50 dark:bg-emerald-950/50 rounded-lg text-center text-sm text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-700">No active issues</div>
                ) : (
                  <div className="space-y-2">
                    {detailRepo.issues.map((issue, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/50 p-2.5 rounded-lg border border-amber-100 dark:border-amber-700">
                        <i className="fa-solid fa-triangle-exclamation text-amber-500 dark:text-amber-400"></i> {issue}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700">
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Protections</p>
                  <div className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full ${detailRepo.protectionsActive ? "bg-emerald-500" : "bg-rose-500"}`}></span>
                    <span className="font-bold text-slate-700 dark:text-slate-300">{detailRepo.protectionsActive ? "Active" : "Inactive"}</span>
                  </div>
                </div>
                <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-xl border border-slate-100 dark:border-slate-700">
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">Outside Collaborators</p>
                  <div className="flex items-center gap-2">
                    <i className="fa-solid fa-users text-slate-400 dark:text-slate-500 text-xs"></i>
                    <span className="font-bold text-slate-700 dark:text-slate-300">{detailRepo.outsideCollaborators}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 flex justify-end">
              <button onClick={() => setDetailRepo(null)} className="mr-auto px-4 py-2 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* --- SNACK --- */}
      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`px-4 py-3 rounded-lg shadow-modal flex items-center gap-3 text-sm font-medium text-white ${snack.severity === "success" ? "bg-emerald-600" : "bg-rose-600"}`}>
            <i className={`fa-solid ${snack.severity === "success" ? "fa-circle-check" : "fa-triangle-exclamation"} text-lg`}></i>
            {snack.msg}
            <button onClick={() => setSnack(null)} className="ml-2 text-white/70 hover:text-white"><i className="fa-solid fa-xmark"></i></button>
          </div>
        </div>
      )}
    </div>
  );
}


/* ────────────────────── Rule Card Component ────────────────────── */

function RuleCard({ rule, onToggle, onRemove, onUpdate, onUpdateField, onUpdateRules }: {
  rule: ComplianceRule & { fileInputVal?: string };
  onToggle: () => void;
  onRemove: () => void;
  onUpdate: (p: Partial<ComplianceRule & { fileInputVal?: string }>) => void;
  onUpdateField: (f: string, v: unknown) => void;
  onUpdateRules: (f: string, v: unknown) => void;
}) {
  const ic = RULE_ICON_COLORS[rule.type] || { bg: "bg-slate-50 dark:bg-slate-800", text: "text-slate-600 dark:text-slate-400" };

  return (
    <div className={`bg-white dark:bg-slate-900 rounded-xl border shadow-sm overflow-hidden transition-all ${rule.enabled ? "border-slate-200 dark:border-slate-700" : "border-dashed border-slate-300 dark:border-slate-600 opacity-60"}`}>
      <div className="p-4 flex items-center gap-4">
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input type="checkbox" checked={rule.enabled} onChange={onToggle} className="sr-only peer" />
          <div className="w-11 h-6 bg-slate-200 dark:bg-slate-600 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white dark:after:bg-slate-200 after:border-gray-300 dark:after:border-slate-500 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-slate-800 dark:peer-checked:bg-blue-600"></div>
        </label>
        <div className={`w-10 h-10 rounded-lg ${ic.bg} ${ic.text} flex items-center justify-center shrink-0`}>
          <i className={`${RULE_TYPE_ICONS[rule.type]} text-lg`}></i>
        </div>
        <input type="text" value={rule.name} onChange={e => onUpdateField("name", e.target.value)} className="flex-1 font-bold text-slate-800 dark:text-slate-200 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-600 focus:border-slate-500 dark:focus:border-slate-400 focus:outline-none transition-colors text-sm" />
        <div className="flex items-center gap-2 shrink-0">
          <input type="number" min={0} max={100} value={rule.weight} onChange={e => onUpdateField("weight", Number(e.target.value))} className="w-14 h-8 text-center text-sm font-mono border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 rounded focus:ring-2 focus:ring-slate-400/20 focus:border-slate-400 outline-none" />
          <button onClick={onRemove} className="w-8 h-8 flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-500 dark:hover:text-rose-400 transition-colors"><i className="fa-regular fa-trash-can"></i></button>
        </div>
      </div>

      {rule.enabled && (
        <div className="px-4 pb-4 border-t border-slate-100 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/50 pt-4">
          {rule.type === "branch_protection" && <BranchProtectionConfig rule={rule} onUpdateField={onUpdateField} onUpdateRules={onUpdateRules} onUpdate={onUpdate} />}
          {rule.type === "tag_protection" && (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 dark:text-slate-400">Tag patterns that must have active ruleset protection (e.g. v*, release-*).</p>
              <TagInput tags={rule.tagPatterns || []} onChange={tags => onUpdateField("tagPatterns", tags)} placeholder="e.g. v* or release-* + Enter" icon="ph-tag" colorClass="gray" />
            </div>
          )}
          {rule.type === "rulesets" && <p className="text-xs text-slate-500 dark:text-slate-400">Checks that at least one active repository ruleset exists.</p>}
          {rule.type === "required_files" && <RequiredFilesConfig rule={rule} onUpdate={onUpdate} />}
          {rule.type === "outside_collaborators" && (
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">Max allowed</label>
              <input type="number" min={0} value={rule.maxOutsideCollaborators ?? 0} onChange={e => onUpdateField("maxOutsideCollaborators", Number(e.target.value))} className="w-16 text-center text-xs border border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 rounded px-2 py-1.5 outline-none focus:border-slate-400" />
            </div>
          )}
          {rule.type === "codeowners" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500 dark:text-slate-400">Checks for a <code className="bg-slate-100 dark:bg-slate-700 px-1 py-0.5 rounded font-mono text-[11px]">CODEOWNERS</code> file in standard locations.</p>
              <div>
                <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">Required Entries <span className="font-normal">(optional)</span></label>
                <TagInput tags={rule.codeownersRequireEntries || []} onChange={tags => onUpdate({ codeownersRequireEntries: tags })} placeholder="e.g. * @org/security-team + Enter" />
              </div>
            </div>
          )}
          {rule.type === "query" && <QueryRuleConfig rule={rule} onUpdateField={onUpdateField} />}
        </div>
      )}
    </div>
  );
}

function RequiredFilesConfig({ rule, onUpdate }: { rule: ComplianceRule & { fileInputVal?: string }; onUpdate: (p: Partial<ComplianceRule & { fileInputVal?: string }>) => void }) {
  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && rule.fileInputVal?.trim()) {
      e.preventDefault();
      const f = rule.fileInputVal.trim();
      if (!rule.requiredFiles?.includes(f)) onUpdate({ requiredFiles: [...(rule.requiredFiles || []), f], fileInputVal: "" });
    } else if (e.key === "Backspace" && !rule.fileInputVal && rule.requiredFiles?.length) {
      e.preventDefault();
      onUpdate({ requiredFiles: rule.requiredFiles.slice(0, -1) });
    }
  };
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1.5">File Paths</label>
      <div className="flex flex-wrap gap-2 items-center bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg p-2 focus-within:border-slate-400 focus-within:ring-1 focus-within:ring-slate-400/20 transition-all">
        {(rule.requiredFiles || []).map(f => (
          <span key={f} className="px-2 py-1 bg-slate-100 dark:bg-slate-700 text-xs text-slate-600 dark:text-slate-300 rounded border border-slate-200 dark:border-slate-600 font-mono flex items-center gap-1">
            {f}
            <button type="button" onClick={() => onUpdate({ requiredFiles: rule.requiredFiles?.filter(x => x !== f) })} className="text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300"><i className="fa-solid fa-xmark text-[9px]"></i></button>
          </span>
        ))}
        <input type="text" value={rule.fileInputVal || ""} onChange={e => onUpdate({ fileInputVal: e.target.value })} onKeyDown={handleKey} placeholder={rule.requiredFiles?.length ? "Add file + Enter" : "e.g. README.md + Enter"} className="flex-1 min-w-[140px] border-none focus:ring-0 text-xs py-0.5 font-mono bg-transparent outline-none shadow-none placeholder-slate-400 dark:placeholder-slate-500 dark:text-slate-200" />
      </div>
    </div>
  );
}

function BranchProtectionConfig({ rule, onUpdateField, onUpdateRules, onUpdate }: {
  rule: ComplianceRule & { hasPendingBranch?: boolean };
  onUpdateField: (f: string, v: unknown) => void;
  onUpdateRules: (f: string, v: unknown) => void;
  onUpdate: (p: Partial<ComplianceRule & { hasPendingBranch?: boolean }>) => void;
}) {
  const hasRules = !!rule.rules && Object.values(rule.rules).some(v => v !== undefined && v !== false && v !== 0);
  const raw = rule.branchName ?? "__default__";
  const branches = raw.split(",").map(b => b.trim()).filter(Boolean);
  const isDefault = branches.includes("__default__");
  const tags = branches.filter(b => b !== "__default__");
  const build = (t: string[], d: boolean) => { const p = [...t]; if (d) p.push("__default__"); return p.length ? p.join(", ") : ""; };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex-1 space-y-2">
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">Branches</label>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" checked={isDefault} onChange={e => onUpdateField("branchName", build(tags, e.target.checked))} className="rounded border-slate-300 dark:border-slate-600 text-slate-800 focus:ring-slate-500" />
            <span className="font-medium text-slate-700 dark:text-slate-300">Include default branch</span>
          </label>
          <TagInput tags={tags} onChange={t => onUpdateField("branchName", build(t, isDefault))} placeholder="Branch name + Enter" onPendingTextChange={p => onUpdate({ hasPendingBranch: p })} icon="ph-git-branch" colorClass="blue" />
        </div>
        <div className="w-full sm:w-48 space-y-2">
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase">Type</label>
          <select value={rule.protectionType || "any"} onChange={e => onUpdateField("protectionType", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400">
            <option value="any">Any protection</option>
            <option value="classic">Classic only</option>
            <option value="ruleset">Ruleset only</option>
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs cursor-pointer">
        <input type="checkbox" checked={hasRules} onChange={e => { if (e.target.checked) onUpdate({ rules: { requirePr: true, minApprovals: 1 } }); else onUpdate({ rules: undefined }); }} className="rounded border-slate-300 dark:border-slate-600 text-slate-800 focus:ring-slate-500" />
        <span className="font-medium text-slate-700 dark:text-slate-300">Check specific rules</span>
      </label>

      {hasRules && (
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4">
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requirePr} onChange={e => onUpdateRules("requirePr", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require Pull Request</span></label>
            {rule.rules?.requirePr && (
              <div className="flex items-center gap-2 text-xs"><span className="text-slate-500 dark:text-slate-400">Min Approvals:</span><input type="number" min={1} max={5} value={rule.rules?.minApprovals || 1} onChange={e => onUpdateRules("minApprovals", parseInt(e.target.value))} className="w-14 rounded border-slate-200 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 py-0.5 px-2 text-xs outline-none focus:border-slate-400" /></div>
            )}
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.dismissStaleReviews} onChange={e => onUpdateRules("dismissStaleReviews", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Dismiss stale reviews</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.preventForcePush} onChange={e => onUpdateRules("preventForcePush", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Prevent force push</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.preventDeletion} onChange={e => onUpdateRules("preventDeletion", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Prevent deletion</span></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.enforceAdmins} onChange={e => onUpdateRules("enforceAdmins", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Enforce for admins</span></label>
          </div>
          <details className="group/adv">
            <summary className="text-xs font-bold text-slate-500 dark:text-slate-400 cursor-pointer flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-300 select-none pt-2 border-t border-slate-100 dark:border-slate-700">
              Advanced <i className="fa-solid fa-chevron-down text-[9px] transition-transform group-open/adv:rotate-180"></i>
            </summary>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4 pl-2 border-l-2 border-slate-200 dark:border-slate-600">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireCodeOwnerReviews} onChange={e => onUpdateRules("requireCodeOwnerReviews", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require Code Owner review</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireConversationResolution} onChange={e => onUpdateRules("requireConversationResolution", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require conversation resolution</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireStatusChecks} onChange={e => onUpdateRules("requireStatusChecks", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require status checks</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.strictStatusChecks} onChange={e => onUpdateRules("strictStatusChecks", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Strict status checks</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireSignedCommits} onChange={e => onUpdateRules("requireSignedCommits", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require signed commits</span></label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!rule.rules?.requireLinearHistory} onChange={e => onUpdateRules("requireLinearHistory", e.target.checked)} className="rounded border-slate-300 dark:border-slate-600 text-slate-800" /> <span className="text-slate-700 dark:text-slate-300">Require linear history</span></label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

function QueryRuleConfig({ rule, onUpdateField }: { rule: ComplianceRule; onUpdateField: (f: string, v: unknown) => void }) {
  const sel = QUERY_OPTIONS.find(q => q.id === rule.queryId);
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">Query</label>
        <select value={rule.queryId || ""} onChange={e => onUpdateField("queryId", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400">
          {QUERY_OPTIONS.map(q => <option key={q.id} value={q.id}>{q.label}</option>)}
        </select>
      </div>
      {sel?.requiresParam && (
        <div>
          <label className="block text-xs font-bold text-slate-400 dark:text-slate-500 uppercase mb-1">{sel.paramLabel}</label>
          <input type="text" value={rule.queryParam || ""} onChange={e => onUpdateField("queryParam", e.target.value)} className="block w-full rounded-md text-xs border-slate-200 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 py-1.5 px-2 ring-1 ring-inset ring-slate-200 dark:ring-slate-600 outline-none focus:border-slate-400" />
        </div>
      )}
      <p className="text-[10px] text-slate-500 dark:text-slate-400">Repos matching this query will fail this compliance check.</p>
    </div>
  );
}
