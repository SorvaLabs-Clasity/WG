import React, { useState, useEffect } from "react";
import { useComplianceDashboard, useComplianceConfig, useUpdateComplianceConfig } from "../hooks/useCompliance";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import type { ComplianceRule } from "../types/Compliance";
import { QUERY_OPTIONS } from "../utils/queryOptions";
import { TagInput } from "../components/TagInput";

const RULE_TYPE_LABELS: Record<string, string> = {
  branch_protection: "Branch Protection",
  rulesets: "Active Rulesets",
  required_files: "Required Files",
  outside_collaborators: "Outside Collaborators",
  query: "Security Insight Query",
};

const RULE_TYPE_ICONS: Record<string, string> = {
  branch_protection: "ph-shield-check",
  rulesets: "ph-list-checks",
  required_files: "ph-file-text",
  outside_collaborators: "ph-users",
  query: "ph-magnifying-glass",
};

function newId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function ComplianceDashboardPage() {
  const { data: scores, isLoading } = useComplianceDashboard();
  const { data: configData, isLoading: configLoading } = useComplianceConfig();
  const updateConfigMutation = useUpdateComplianceConfig();
  const [searchTerm, setSearchTerm] = useState("");
  const { user } = useAuth();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rules, setRules] = useState<(ComplianceRule & { fileInputVal?: string; hasPendingBranch?: boolean })[]>([]);
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  useEffect(() => {
    if (configData?.rules) {
      setRules(configData.rules.map(r => ({ ...r, fileInputVal: "", hasPendingBranch: false })));
    }
  }, [configData]);

  const handleSave = () => {
    if (rules.some(r => r.hasPendingBranch)) return;
    const cleaned = rules.map(({ fileInputVal, hasPendingBranch, ...rest }) => rest);
    updateConfigMutation.mutate({ rules: cleaned }, {
      onSuccess: () => {
        setSnack({ msg: "Compliance requirements saved", severity: "success" });
      },
      onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
    });
  };

  const addRule = (type: ComplianceRule["type"]) => {
    const base: ComplianceRule = {
      id: newId(),
      name: RULE_TYPE_LABELS[type] || "New Rule",
      enabled: true,
      weight: 10,
      type,
    };
    if (type === "branch_protection") {
      base.branchName = "__default__";
      base.protectionType = "any";
    }
    if (type === "required_files") base.requiredFiles = ["README.md"];
    if (type === "outside_collaborators") base.maxOutsideCollaborators = 0;
    if (type === "query") base.queryId = QUERY_OPTIONS[0].id;
    setRules([...rules, { ...base, fileInputVal: "" }]);
  };

  const removeRule = (idx: number) => setRules(rules.filter((_, i) => i !== idx));
  const updateRule = (idx: number, patch: Partial<ComplianceRule & { fileInputVal?: string }>) => {
    setRules(rules.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const updateRuleField = (idx: number, field: string, val: unknown) => {
    const r = { ...rules[idx], [field]: val };
    setRules(rules.map((orig, i) => (i === idx ? r : orig)));
  };
  const updateRuleRules = (idx: number, field: string, val: unknown) => {
    const r = { ...rules[idx], rules: { ...rules[idx].rules, [field]: val } };
    setRules(rules.map((orig, i) => (i === idx ? r : orig)));
  };

  if (isLoading || configLoading) {
    return (
      <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-8 flex justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-gh-blue border-t-transparent rounded-full"></div>
        </div>
      </div>
    );
  }

  const filteredScores = (scores || []).filter((s) =>
    s.repo.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const averageScore = scores && scores.length > 0
    ? Math.round(scores.reduce((acc, curr) => acc + curr.score, 0) / scores.length)
    : 0;

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-6xl mx-auto p-4 sm:p-8 animate-fade-in">
        <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase flex items-center gap-2">
              <i className="ph-fill ph-check-square-offset text-gh-textMuted"></i>
              Repo Compliance Dashboard
            </h1>
            <p className="text-gh-muted text-sm mt-1">
              Overview of repository security posture, required files, and external access.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-semibold border transition-all ${
                settingsOpen
                  ? "bg-gh-blue text-white border-gh-blue"
                  : "bg-white text-gh-textBase border-gh-border hover:border-gh-blue hover:text-gh-blue"
              }`}
            >
              <i className="ph-bold ph-gear"></i>
              Requirements
            </button>

            <div className="bg-white px-6 py-3 rounded-xl border border-gh-border shadow-sm flex items-center gap-4">
              <div>
                <p className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-1">Average Score</p>
                <div className="flex items-end gap-2">
                  <span className={`text-3xl font-bold ${averageScore >= 90 ? 'text-green-600' : averageScore >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                    {averageScore}
                  </span>
                  <span className="text-sm font-medium text-gh-muted mb-1">/ 100</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Settings Panel */}
        {settingsOpen && (() => {
          const totalWeight = rules.filter(r => r.enabled).reduce((sum, r) => sum + (r.weight || 0), 0);
          const weightValid = totalWeight === 100;
          const hasPendingText = rules.some(r => r.hasPendingBranch);
          const saveDisabled = updateConfigMutation.isPending || !weightValid || hasPendingText;
          return (
          <div className="mb-8 bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden animate-fade-in">
            <div className="p-5 border-b border-gh-border bg-gradient-to-r from-white to-gray-50/50 flex justify-between items-center">
              <div>
                <h2 className="text-base font-bold text-gh-textBase">Compliance Requirements</h2>
                <p className="text-xs text-gh-muted mt-0.5">Customize what gets checked and how much each rule weighs in the score.</p>
              </div>
              <div className="flex items-center gap-3">
                <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border ${
                  weightValid
                    ? 'bg-green-50 text-green-700 border-green-200'
                    : 'bg-red-50 text-red-700 border-red-200'
                }`}>
                  <i className={`ph-bold ${weightValid ? 'ph-check-circle' : 'ph-warning-circle'} text-sm`}></i>
                  Weight: {totalWeight} / 100
                </div>
                <button
                  onClick={handleSave}
                  disabled={saveDisabled}
                  title={!weightValid ? `Total weight must equal 100 (currently ${totalWeight})` : hasPendingText ? "Press Enter to add the pending branch name" : undefined}
                  className="px-4 py-1.5 bg-gh-blue text-white text-sm font-semibold rounded-md hover:bg-gh-blueHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {updateConfigMutation.isPending ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>

            <div className="p-5 space-y-3">
              {rules.map((rule, idx) => (
                <RuleCard
                  key={rule.id}
                  rule={rule}
                  onToggle={() => updateRuleField(idx, "enabled", !rule.enabled)}
                  onRemove={() => removeRule(idx)}
                  onUpdate={(patch) => updateRule(idx, patch)}
                  onUpdateField={(f, v) => updateRuleField(idx, f, v)}
                  onUpdateRules={(f, v) => updateRuleRules(idx, f, v)}
                />
              ))}

              {rules.length === 0 && (
                <p className="text-sm text-gh-muted text-center py-6">No compliance rules configured. Add one below.</p>
              )}

              <div className="pt-3 border-t border-gh-border">
                <p className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-2">Add Rule</p>
                <div className="flex flex-wrap gap-2">
                  {(["branch_protection", "rulesets", "required_files", "outside_collaborators", "query"] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => addRule(t)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 border-2 border-dashed border-gray-300 rounded-lg text-xs font-medium text-gray-500 hover:text-gh-blue hover:border-gh-blue hover:bg-blue-50 transition-all"
                    >
                      <i className={`ph ${RULE_TYPE_ICONS[t]}`}></i>
                      {RULE_TYPE_LABELS[t]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
          );
        })()}

        {/* Dashboard Table */}
        <div className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gh-border bg-gray-50 flex justify-between items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <i className="ph ph-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
              <input
                type="text"
                placeholder="Search repositories..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-white border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-colors"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted">Repository</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted">Score</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Protections</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Rulesets</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Required Files</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted text-center">Outside Collabs</th>
                  <th className="px-6 py-3 font-semibold text-gh-textMuted">Issues</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {filteredScores.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-gh-muted">
                      No repositories found matching your search.
                    </td>
                  </tr>
                ) : (
                  filteredScores.map((scoreInfo) => (
                    <tr key={scoreInfo.repo} className="hover:bg-gray-50 transition-colors group">
                      <td className="px-6 py-4 font-bold text-gh-textBase">
                        <div className="flex items-center gap-2">
                          <i className="ph ph-git-repository text-gh-muted"></i>
                          {scoreInfo.repo}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${scoreInfo.score >= 90 ? 'bg-green-500' : scoreInfo.score >= 70 ? 'bg-yellow-500' : 'bg-red-500'}`}
                              style={{ width: `${scoreInfo.score}%` }}
                            />
                          </div>
                          <span className={`font-bold ${scoreInfo.score >= 90 ? 'text-green-600' : scoreInfo.score >= 70 ? 'text-yellow-600' : 'text-red-600'}`}>
                            {scoreInfo.score}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        {scoreInfo.protectionsActive ? (
                          <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                        ) : (
                          <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {scoreInfo.rulesetsActive ? (
                          <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                        ) : (
                          <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {scoreInfo.hasRequiredFiles ? (
                          <i className="ph-fill ph-check-circle text-green-500 text-lg"></i>
                        ) : (
                          <i className="ph-fill ph-x-circle text-red-500 text-lg"></i>
                        )}
                      </td>
                      <td className="px-6 py-4 text-center">
                        {scoreInfo.outsideCollaborators === 0 ? (
                          <span className="inline-flex items-center justify-center bg-green-50 text-green-700 w-6 h-6 rounded-full text-xs font-bold">0</span>
                        ) : (
                          <span className="inline-flex items-center justify-center bg-red-50 text-red-700 w-6 h-6 rounded-full text-xs font-bold ring-2 ring-red-100">{scoreInfo.outsideCollaborators}</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {scoreInfo.issues.length === 0 ? (
                          <span className="text-xs text-green-600 font-medium bg-green-50 px-2 py-1 rounded border border-green-100">All compliant</span>
                        ) : (
                          <div className="flex flex-col gap-1">
                            {scoreInfo.issues.map((issue, idx) => (
                              <span key={idx} className="text-xs text-red-600 flex items-start gap-1">
                                <i className="ph-fill ph-warning-circle mt-0.5 shrink-0"></i>
                                <span className="truncate max-w-[200px]" title={issue}>{issue}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`px-4 py-3 rounded-lg shadow-modal flex items-center gap-3 text-sm font-medium text-white ${
            snack.severity === 'success' ? 'bg-green-600' : 'bg-red-600'
          }`}>
            <i className={`ph-fill ${snack.severity === 'success' ? 'ph-check-circle' : 'ph-warning-circle'} text-lg`}></i>
            {snack.msg}
            <button onClick={() => setSnack(null)} className="ml-2 text-white/70 hover:text-white transition-colors">
              <i className="ph ph-x"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function RuleCard({
  rule,
  onToggle,
  onRemove,
  onUpdate,
  onUpdateField,
  onUpdateRules,
}: {
  rule: ComplianceRule & { fileInputVal?: string };
  onToggle: () => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<ComplianceRule & { fileInputVal?: string }>) => void;
  onUpdateField: (field: string, val: unknown) => void;
  onUpdateRules: (field: string, val: unknown) => void;
}) {
  const selectedQuery = rule.type === "query" ? QUERY_OPTIONS.find(q => q.id === rule.queryId) : null;

  const handleFileKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && rule.fileInputVal?.trim()) {
      e.preventDefault();
      const f = rule.fileInputVal.trim();
      if (!rule.requiredFiles?.includes(f)) {
        onUpdate({ requiredFiles: [...(rule.requiredFiles || []), f], fileInputVal: "" });
      }
    } else if (e.key === "Backspace" && !rule.fileInputVal && rule.requiredFiles?.length) {
      e.preventDefault();
      onUpdate({ requiredFiles: rule.requiredFiles.slice(0, -1) });
    }
  };

  return (
    <div className={`border rounded-lg transition-all ${rule.enabled ? 'border-gh-border bg-white shadow-sm' : 'border-dashed border-gray-300 bg-gray-50/50 opacity-70'}`}>
      <div className="px-4 py-3 flex items-center gap-3">
        <div
          className={`w-9 h-5 flex items-center rounded-full p-0.5 cursor-pointer transition-colors ${rule.enabled ? 'bg-green-600' : 'bg-gray-300'}`}
          onClick={onToggle}
        >
          <div className={`bg-white w-4 h-4 rounded-full shadow-md transition-transform ${rule.enabled ? 'translate-x-4' : ''}`}></div>
        </div>

        <i className={`ph ${RULE_TYPE_ICONS[rule.type]} text-gh-muted`}></i>

        <input
          type="text"
          value={rule.name}
          onChange={(e) => onUpdateField("name", e.target.value)}
          className="flex-1 text-sm font-semibold text-gh-textBase bg-transparent border-none outline-none focus:ring-0 p-0"
        />

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-semibold text-gh-muted uppercase">Weight</span>
          <input
            type="number"
            min={0}
            max={100}
            value={rule.weight}
            onChange={(e) => onUpdateField("weight", Number(e.target.value))}
            className="w-14 text-center text-xs font-bold border border-gray-300 rounded px-1 py-0.5 outline-none focus:border-gh-blue"
          />

          <button onClick={onRemove} className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors ml-1">
            <i className="ph-bold ph-trash text-sm"></i>
          </button>
        </div>
      </div>

      {rule.enabled && (
        <div className="px-4 pb-4 pt-1 border-t border-gray-100">
          {rule.type === "branch_protection" && (
            <BranchProtectionConfig rule={rule} onUpdateField={onUpdateField} onUpdateRules={onUpdateRules} onUpdate={onUpdate} />
          )}
          {rule.type === "required_files" && (
            <div>
              <label className="block text-xs font-semibold text-gh-muted mb-1.5">Required Files</label>
              <div className="flex items-center bg-gray-50 rounded-md border border-gray-300 focus-within:border-gh-blue focus-within:ring-1 focus-within:ring-gh-blue/30 min-h-[36px] flex-wrap px-1.5 py-1 gap-1.5 transition-all">
                {(rule.requiredFiles || []).map(f => (
                  <span key={f} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white text-gh-textBase border border-gray-200 shadow-sm text-xs font-mono whitespace-nowrap">
                    {f}
                    <button type="button" onClick={() => onUpdate({ requiredFiles: rule.requiredFiles?.filter(x => x !== f) })} className="text-gray-400 hover:text-gray-600">
                      <i className="ph ph-x text-[10px]"></i>
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={rule.fileInputVal || ""}
                  onChange={(e) => onUpdate({ fileInputVal: e.target.value })}
                  onKeyDown={handleFileKeyDown}
                  placeholder={rule.requiredFiles?.length ? "Add file + Enter" : "e.g. README.md + Enter"}
                  className="flex-1 min-w-[140px] border-none focus:ring-0 text-xs py-0.5 font-mono bg-transparent outline-none m-0 p-0 shadow-none placeholder-gray-400"
                />
              </div>
            </div>
          )}
          {rule.type === "outside_collaborators" && (
            <div className="flex items-center gap-3">
              <label className="text-xs font-semibold text-gh-muted">Max allowed outside collaborators</label>
              <input
                type="number"
                min={0}
                value={rule.maxOutsideCollaborators ?? 0}
                onChange={(e) => onUpdateField("maxOutsideCollaborators", Number(e.target.value))}
                className="w-16 text-center text-xs border border-gray-300 rounded px-2 py-1 outline-none focus:border-gh-blue"
              />
            </div>
          )}
          {rule.type === "rulesets" && (
            <p className="text-xs text-gh-muted">Checks that at least one active repository ruleset exists.</p>
          )}
          {rule.type === "query" && (
            <QueryRuleConfig rule={rule} onUpdateField={onUpdateField} />
          )}
        </div>
      )}
    </div>
  );
}


function BranchProtectionConfig({
  rule,
  onUpdateField,
  onUpdateRules,
  onUpdate,
}: {
  rule: ComplianceRule & { hasPendingBranch?: boolean };
  onUpdateField: (f: string, v: unknown) => void;
  onUpdateRules: (f: string, v: unknown) => void;
  onUpdate: (patch: Partial<ComplianceRule & { hasPendingBranch?: boolean }>) => void;
}) {
  const hasRules = !!rule.rules && Object.values(rule.rules).some(v => v !== undefined && v !== false && v !== 0);
  const raw = rule.branchName ?? "__default__";
  const branches = raw.split(",").map(b => b.trim()).filter(Boolean);
  const isDefault = branches.includes("__default__");
  const tags = branches.filter(b => b !== "__default__");

  const buildBranchName = (newTags: string[], includeDefault: boolean) => {
    const parts = [...newTags];
    if (includeDefault) parts.push("__default__");
    return parts.length > 0 ? parts.join(", ") : "";
  };

  const setTags = (newTags: string[]) => {
    onUpdateField("branchName", buildBranchName(newTags, isDefault));
  };

  const toggleDefault = (checked: boolean) => {
    onUpdateField("branchName", buildBranchName(tags, checked));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex-1 space-y-2">
          <label className="block text-xs font-semibold text-gh-muted">Branches to Check</label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs cursor-pointer mb-1">
              <input
                type="checkbox"
                checked={isDefault}
                onChange={(e) => toggleDefault(e.target.checked)}
                className="rounded text-gh-blue focus:ring-gh-blue"
              />
              <span className="font-medium text-gh-textBase">Include repository default branch</span>
            </label>
            <TagInput
              tags={tags}
              onChange={setTags}
              placeholder="Type branch name and press Enter"
              onPendingTextChange={(pending) => onUpdate({ hasPendingBranch: pending })}
              icon="ph-git-branch"
              colorClass="blue"
            />
          </div>
        </div>
        
        <div className="w-full sm:w-48 space-y-2">
          <label className="block text-xs font-semibold text-gh-muted">Protection Type</label>
          <select
            value={rule.protectionType || "any"}
            onChange={(e) => onUpdateField("protectionType", e.target.value)}
            className="block w-full rounded-md text-xs border-gray-300 py-1.5 px-2 ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
          >
            <option value="any">Any protection</option>
            <option value="classic">Classic only</option>
            <option value="ruleset">Ruleset only</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={hasRules}
          onChange={(e) => {
            if (e.target.checked) {
              onUpdate({ rules: { requirePr: true, minApprovals: 1 } });
            } else {
              onUpdate({ rules: undefined });
            }
          }}
          className="rounded text-gh-blue focus:ring-gh-blue"
        />
        <span className="text-xs font-medium text-gh-textBase">Check for specific protection rules</span>
      </div>

      {hasRules && (
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rule.rules?.requirePr} onChange={(e) => onUpdateRules("requirePr", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
              <span className="font-medium text-gh-textBase">Require Pull Request</span>
            </label>

            {rule.rules?.requirePr && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gh-muted">Min. Approvals:</span>
                <input
                  type="number" min={1} max={5}
                  value={rule.rules?.minApprovals || 1}
                  onChange={(e) => onUpdateRules("minApprovals", parseInt(e.target.value))}
                  className="w-14 rounded-md border-gray-300 py-0.5 px-2 text-xs ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
                />
              </div>
            )}

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rule.rules?.dismissStaleReviews} onChange={(e) => onUpdateRules("dismissStaleReviews", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
              <span className="font-medium text-gh-textBase">Dismiss stale reviews</span>
            </label>

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rule.rules?.preventForcePush} onChange={(e) => onUpdateRules("preventForcePush", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
              <span className="font-medium text-gh-textBase">Prevent force pushing</span>
            </label>

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rule.rules?.preventDeletion} onChange={(e) => onUpdateRules("preventDeletion", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
              <span className="font-medium text-gh-textBase">Prevent deletion</span>
            </label>

            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={!!rule.rules?.enforceAdmins} onChange={(e) => onUpdateRules("enforceAdmins", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
              <span className="font-medium text-gh-textBase">Enforce for admins</span>
            </label>
          </div>

          <details className="group/det">
            <summary className="text-[11px] font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1 select-none pt-2 border-t border-gray-200">
              <i className="ph-bold ph-caret-right text-[10px] group-open/det:rotate-90 transition-transform"></i>
              Advanced Rules
            </summary>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2.5 gap-x-4 pt-3 mt-1">
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.requireCodeOwnerReviews} onChange={(e) => onUpdateRules("requireCodeOwnerReviews", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Require Code Owner review</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.requireConversationResolution} onChange={(e) => onUpdateRules("requireConversationResolution", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Require conversation resolution</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.requireStatusChecks} onChange={(e) => onUpdateRules("requireStatusChecks", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Require status checks</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.strictStatusChecks} onChange={(e) => onUpdateRules("strictStatusChecks", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Strict status checks (up to date)</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.requireSignedCommits} onChange={(e) => onUpdateRules("requireSignedCommits", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Require signed commits</span>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!rule.rules?.requireLinearHistory} onChange={(e) => onUpdateRules("requireLinearHistory", e.target.checked)} className="rounded text-gh-blue focus:ring-gh-blue" />
                <span className="font-medium text-gh-textBase">Require linear history</span>
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}


function QueryRuleConfig({
  rule,
  onUpdateField,
}: {
  rule: ComplianceRule;
  onUpdateField: (f: string, v: unknown) => void;
}) {
  const selectedQuery = QUERY_OPTIONS.find(q => q.id === rule.queryId);

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-semibold text-gh-muted mb-1">Query</label>
        <select
          value={rule.queryId || ""}
          onChange={(e) => onUpdateField("queryId", e.target.value)}
          className="block w-full rounded-md text-xs border-gray-300 py-1.5 px-2 ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
        >
          {QUERY_OPTIONS.map(q => (
            <option key={q.id} value={q.id}>{q.label}</option>
          ))}
        </select>
      </div>
      {selectedQuery?.requiresParam && (
        <div>
          <label className="block text-xs font-semibold text-gh-muted mb-1">{selectedQuery.paramLabel}</label>
          <input
            type="text"
            value={rule.queryParam || ""}
            onChange={(e) => onUpdateField("queryParam", e.target.value)}
            className="block w-full rounded-md text-xs border-gray-300 py-1.5 px-2 ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
          />
        </div>
      )}
      <p className="text-[10px] text-gh-muted">Repos that match this query will fail this compliance check.</p>
    </div>
  );
}
