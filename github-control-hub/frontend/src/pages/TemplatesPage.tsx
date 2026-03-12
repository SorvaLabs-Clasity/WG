import { useState } from "react";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";
import {
  useTemplates,
  useCreateTemplate,
  useUpdateTemplate,
  useDeleteTemplate,
  useApplyTemplate,
} from "../hooks/useTemplates";
import {
  useExclusions,
  useCreateExclusion,
  useUpdateExclusion,
  useDeleteExclusion,
} from "../hooks/useExclusions";
import { useResolveConflict } from "../hooks/useActivity";
import { useRepos } from "../hooks/useRepos";
import type { BranchRule } from "../types/Template";
import { buildConflictComparison, type ConflictItem } from "../api/templates";
import ProtectBranchModal, { DEFAULT_PROTECTION } from "../components/ProtectBranchModal";

const EMPTY_RULE: BranchRule & { inputVal: string } = {
  branchNames: [],
  inputVal: "",
  protection: null,
};


export default function TemplatesPage() {
  const { user } = useAuth();
  const { data: templates, isLoading, error } = useTemplates();
  const { data: repos } = useRepos();
  const createMutation = useCreateTemplate();
  const updateMutation = useUpdateTemplate();
  const deleteMutation = useDeleteTemplate();
  const applyMutation = useApplyTemplate();

  const { data: exclusions } = useExclusions();
  const createExclMutation = useCreateExclusion();
  const updateExclMutation = useUpdateExclusion();
  const deleteExclMutation = useDeleteExclusion();

  const resolveMutation = useResolveConflict();

  const [activeTab, setActiveTab] = useState<"templates" | "exclusions">("templates");
  const [conflictItems, setConflictItems] = useState<(ConflictItem & { resolved?: "override" | "skip"; resolving?: boolean })[]>([]);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [expandedConflicts, setExpandedConflicts] = useState<Set<number>>(new Set());

  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingRuleIdx, setEditingRuleIdx] = useState<number | null>(null);
  const [applyOpen, setApplyOpen] = useState<string | null>(null);
  const [applyRepos, setApplyRepos] = useState<string[]>([]);
  const [applySearch, setApplySearch] = useState("");
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  // Create form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [selectedExclusions, setSelectedExclusions] = useState<string[]>([]);
  const [branchRules, setBranchRules] = useState<(BranchRule & { inputVal: string; jsonMode?: boolean; jsonString?: string; jsonError?: string; importMode?: boolean; importText?: string; importError?: string })[]>([
    { branchNames: ["main"], inputVal: "", protection: { ...DEFAULT_PROTECTION, requiredApprovals: 2 } },
    { branchNames: ["develop"], inputVal: "", protection: null },
  ]);

  // Exclusion list form state
  const [createExclOpen, setCreateExclOpen] = useState(false);
  const [editingExclId, setEditingExclId] = useState<string | null>(null);
  const [exclName, setExclName] = useState("");
  const [exclDescription, setExclDescription] = useState("");
  const [exclRepos, setExclRepos] = useState<string[]>([]);
  const [exclCustomRepos, setExclCustomRepos] = useState<string[]>([]);
  const [exclSearch, setExclSearch] = useState("");
  const [exclForceOnNew, setExclForceOnNew] = useState(false);
  const [exclForceTemplateIds, setExclForceTemplateIds] = useState<string[]>([]);
  const [exclCustomPending, setExclCustomPending] = useState(false);

  const resetExclForm = () => {
    setExclName("");
    setExclDescription("");
    setExclRepos([]);
    setExclCustomRepos([]);
    setExclSearch("");
    setExclForceOnNew(false);
    setExclForceTemplateIds([]);
    setExclCustomPending(false);
    setEditingExclId(null);
  };

  const handleEditExclClick = (excl: any) => {
    setExclName(excl.name);
    setExclDescription(excl.description || "");
    const repoNames = (repos || []).map((r: any) => r.name);
    const existing = (excl.repos || []).filter((r: string) => repoNames.includes(r));
    const custom = (excl.repos || []).filter((r: string) => !repoNames.includes(r));
    setExclRepos(existing);
    setExclCustomRepos(custom);
    setExclSearch("");
    setExclForceOnNew(excl.forceOnNewTemplates || false);
    setExclForceTemplateIds(excl.forceTemplateIds || []);
    setEditingExclId(excl.id);
    setCreateExclOpen(true);
  };

  const handleCreateOrUpdateExcl = () => {
    const allRepos = Array.from(new Set([...exclRepos, ...exclCustomRepos]));
    if (!exclName || allRepos.length === 0) return;
    
    if (editingExclId) {
      updateExclMutation.mutate({ id: editingExclId, data: { name: exclName, description: exclDescription, repos: allRepos, forceTemplateIds: exclForceTemplateIds, forceOnNewTemplates: exclForceOnNew } }, {
        onSuccess: () => {
          setSnack({ msg: `Exclusion list updated`, severity: "success" });
          setCreateExclOpen(false);
          resetExclForm();
        },
        onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
      });
    } else {
      createExclMutation.mutate({ name: exclName, description: exclDescription, repos: allRepos, forceTemplateIds: exclForceTemplateIds, forceOnNewTemplates: exclForceOnNew }, {
        onSuccess: () => {
          setSnack({ msg: `Exclusion list created`, severity: "success" });
          setCreateExclOpen(false);
          resetExclForm();
        },
        onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
      });
    }
  };

  const handleDeleteExcl = (id: string, name: string) => {
    if (!confirm(`Delete exclusion list "${name}"?`)) return;
    deleteExclMutation.mutate(id, {
      onSuccess: () => setSnack({ msg: `Exclusion list deleted`, severity: "success" }),
      onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
    });
  };

  const resetForm = () => {
    setName("");
    setDescription("");
    setAutoApply(false);
    setSelectedExclusions([]);
    setBranchRules([
      { branchNames: ["main"], inputVal: "", protection: { ...DEFAULT_PROTECTION, requiredApprovals: 2 } },
      { branchNames: ["develop"], inputVal: "", protection: null },
    ]);
    setEditingId(null);
  };

  const handleEditClick = (tmpl: any) => {
    setName(tmpl.name);
    setDescription(tmpl.description);
    setAutoApply(tmpl.autoApplyOnNewRepo);
    setSelectedExclusions(tmpl.exclusionLists || []);
    // Deep clone the rules and ensure inputVal exists
    setBranchRules(JSON.parse(JSON.stringify(tmpl.branches)).map((r: any) => ({ ...r, inputVal: "" })));
    setEditingId(tmpl.id);
    setCreateOpen(true);
  };

  const handleCreateOrUpdate = () => {
    // Check if there's text in the input that hasn't been submitted yet.
    const hasPendingInput = branchRules.some(r => r.inputVal && r.inputVal.trim() !== "");
    if (hasPendingInput) {
      setSnack({ msg: "Please press Enter to add all typed branch names before saving.", severity: "error" });
      return;
    }

    const hasJsonErrors = branchRules.some(r => r.jsonMode && r.jsonError);
    if (hasJsonErrors) {
      setSnack({ msg: "Please fix JSON syntax errors before saving.", severity: "error" });
      return;
    }

    const missingRulesetName = branchRules.some(
      r => r.protection?.type === "ruleset" && !(r.protection.rulesetName?.trim())
    );
    if (missingRulesetName) {
      setSnack({ msg: "Ruleset name is required for each branch rule using Repository Ruleset.", severity: "error" });
      return;
    }

    const validRules = branchRules.filter((r) => r.branchNames.length > 0);
    if (!name || validRules.length === 0) return;

    const finalRules = validRules.map(r => ({
      branchNames: [...r.branchNames],
      protection: r.protection
    }));

    if (editingId) {
      updateMutation.mutate(
        { id: editingId, data: { name, description, branches: finalRules, autoApplyOnNewRepo: autoApply, exclusionLists: selectedExclusions } },
        {
          onSuccess: () => {
            setSnack({ msg: `Template "${name}" updated`, severity: "success" });
            setCreateOpen(false);
            resetForm();
          },
          onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
        }
      );
    } else {
      createMutation.mutate(
        { name, description, branches: finalRules, autoApplyOnNewRepo: autoApply, exclusionLists: selectedExclusions },
        {
          onSuccess: () => {
            setSnack({ msg: `Template "${name}" created`, severity: "success" });
            setCreateOpen(false);
            resetForm();
          },
          onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
        }
      );
    }
  };

  const handleDelete = (id: string, templateName: string) => {
    if (!confirm(`Delete template "${templateName}"?`)) return;
    deleteMutation.mutate(id, {
      onSuccess: () => setSnack({ msg: `Template deleted`, severity: "success" }),
      onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
    });
  };

  const handleApply = () => {
    if (!applyOpen || applyRepos.length === 0) return;
    applyMutation.mutate(
      { templateId: applyOpen, repos: applyRepos },
      {
        onSuccess: (result) => {
          const parts = [`Created: [${result.created.join(", ")}]`, `Protected: [${result.protected.join(", ")}]`];
          if (result.errors.length) {
            parts.push(`Errors (${result.errors.length}): ${result.errors.slice(0, 2).join("; ")}${result.errors.length > 2 ? "…" : ""}`);
          }
          const hasConflicts = result.conflicts && result.conflicts.length > 0;
          if (hasConflicts) {
            parts.push(`Conflicts (${result.conflicts!.length})`);
          }
          setSnack({ msg: parts.join(" · "), severity: result.errors.length || hasConflicts ? "error" : "success" });
          setApplyOpen(null);
          setApplyRepos([]);
          setApplySearch("");
          if (hasConflicts) {
            setConflictItems(result.conflicts!.map(c => ({ ...c })));
            setExpandedConflicts(new Set());
            setConflictOpen(true);
          }
        },
        onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
      }
    );
  };

  const handleResolveConflict = (idx: number, resolution: "override" | "skip") => {
    const item = conflictItems[idx];
    if (!item.activityId || item.resolved) return;
    const updated = [...conflictItems];
    updated[idx] = { ...updated[idx], resolving: true };
    setConflictItems(updated);
    resolveMutation.mutate(
      { activityId: item.activityId, resolution },
      {
        onSuccess: () => {
          const next = [...conflictItems];
          next[idx] = { ...next[idx], resolved: resolution, resolving: false };
          setConflictItems(next);
        },
        onError: () => {
          const next = [...conflictItems];
          next[idx] = { ...next[idx], resolving: false };
          setConflictItems(next);
          setSnack({ msg: `Failed to ${resolution} conflict for "${item.name}"`, severity: "error" });
        },
      }
    );
  };

  const handleResolveAll = (resolution: "override" | "skip") => {
    conflictItems.forEach((item, idx) => {
      if (!item.resolved && item.activityId) {
        handleResolveConflict(idx, resolution);
      }
    });
  };

  const addRule = () => setBranchRules([...branchRules, { ...EMPTY_RULE, branchNames: [], inputVal: "" }]);

  const removeRule = (idx: number) =>
    setBranchRules(branchRules.filter((_, i) => i !== idx));

  const updateRuleInput = (idx: number, val: string) => {
    const updated = [...branchRules];
    updated[idx] = { ...updated[idx], inputVal: val };
    setBranchRules(updated);
  };

  const handleRuleInputKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const rule = branchRules[idx];
    if (e.key === 'Enter' && rule.inputVal.trim()) {
      e.preventDefault();
      const newName = rule.inputVal.trim();
      if (!rule.branchNames.includes(newName)) {
        const updated = [...branchRules];
        updated[idx] = { 
          ...updated[idx], 
          branchNames: [...updated[idx].branchNames, newName],
          inputVal: "" 
        };
        setBranchRules(updated);
      }
    } else if (e.key === 'Backspace' && !rule.inputVal && rule.branchNames.length > 0) {
      // Remove last tag on backspace if input is empty
      e.preventDefault();
      const updated = [...branchRules];
      const newNames = [...updated[idx].branchNames];
      newNames.pop();
      updated[idx] = { ...updated[idx], branchNames: newNames };
      setBranchRules(updated);
    }
  };

  const removeBranchFromRule = (ruleIdx: number, branchToRemove: string) => {
    const updated = [...branchRules];
    updated[ruleIdx] = {
      ...updated[ruleIdx],
      branchNames: updated[ruleIdx].branchNames.filter(b => b !== branchToRemove)
    };
    setBranchRules(updated);
  };

  const toggleRuleProtection = (idx: number) => {
    const updated = [...branchRules];
    updated[idx] = {
      ...updated[idx],
      protection: updated[idx].protection ? null : { ...DEFAULT_PROTECTION },
      jsonMode: false,
    };
    setBranchRules(updated);
  };

  const protectionLabel = (rule: BranchRule) => {
    if (!rule.protection) return null;
    const p = rule.protection;
    if (p.type === "ruleset_json") return "Custom JSON Ruleset";
    const kind = p.type === "ruleset" ? "Ruleset" : "Classic";
    const details: string[] = [];
    if (p.requiredApprovals > 0) details.push(`${p.requiredApprovals} Approval${p.requiredApprovals !== 1 ? "s" : ""}`);
    else if (p.requirePr) details.push("Require PR");
    return details.length ? `${kind} · ${details.join(", ")}` : kind;
  };

  return (
    <div className="bg-slate-50 text-slate-900 min-h-screen pt-14 antialiased">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />

      <main className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-10 pb-32">

        {/* --- HEADER --- */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="bg-slate-900 text-white w-12 h-12 rounded-xl flex items-center justify-center shadow-lg">
              <i className="fa-solid fa-layer-group text-xl"></i>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Templates & Automation</h1>
              <p className="text-slate-500 text-sm font-medium mt-0.5">Manage initialization standards across your organization.</p>
            </div>
          </div>
          {activeTab === "templates" ? (
            <button
              onClick={() => setCreateOpen(true)}
              className="bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 flex items-center gap-2 font-medium text-sm group"
            >
              <i className="fa-solid fa-plus text-xs group-hover:rotate-90 transition-transform"></i>
              New Template
            </button>
          ) : (
            <button
              onClick={() => setCreateExclOpen(true)}
              className="bg-slate-900 hover:bg-slate-800 text-white px-5 py-2.5 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 flex items-center gap-2 font-medium text-sm"
            >
              <i className="fa-solid fa-ban text-xs"></i>
              New Exclusion List
            </button>
          )}
        </header>

        {/* --- TABS --- */}
        <div className="mb-8">
          <div className="bg-white rounded-lg border border-slate-200 p-1 shadow-sm inline-flex items-center">
            <button
              onClick={() => setActiveTab("templates")}
              className={`rounded-md px-4 py-2 flex items-center gap-2.5 text-sm font-medium transition-all ${activeTab === "templates" ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}`}
            >
              <i className="fa-solid fa-layer-group text-xs"></i>
              Templates
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "templates" ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-600"}`}>
                {templates?.length ?? 0}
              </span>
            </button>
            <button
              onClick={() => setActiveTab("exclusions")}
              className={`rounded-md px-4 py-2 flex items-center gap-2.5 text-sm font-medium transition-all ml-1 ${activeTab === "exclusions" ? "bg-slate-900 text-white shadow-sm" : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"}`}
            >
              <i className="fa-solid fa-ban text-xs"></i>
              Exclusion Lists
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${activeTab === "exclusions" ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-600"}`}>
                {exclusions?.length ?? 0}
              </span>
            </button>
          </div>
        </div>

        {/* --- TEMPLATES TAB --- */}
        {activeTab === "templates" && (
          <>
            {isLoading && (
              <div className="flex justify-center py-16">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-slate-300 border-t-slate-700"></div>
              </div>
            )}

            {error && (
              <div className="bg-rose-50 border border-rose-200 px-4 py-3 rounded-xl mb-6 text-sm text-rose-700 flex items-center gap-2">
                <i className="fa-solid fa-triangle-exclamation"></i>
                Failed to load templates: {(error as Error).message}
              </div>
            )}

            {!isLoading && !error && templates && templates.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 animate-fade-in">
                {templates.map((tmpl) => (
                  <div key={tmpl.id} className="group bg-white rounded-2xl border border-slate-200 shadow-soft hover:shadow-lg hover:-translate-y-1 transition-all duration-300 flex flex-col h-full relative overflow-hidden">
                    {/* Card Header */}
                    <div className="px-5 py-5 border-b border-slate-100 bg-gradient-to-r from-white to-slate-50/50">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-bold text-lg text-slate-800">{tmpl.name}</h3>
                        {tmpl.autoApplyOnNewRepo && (
                          <span className="bg-blue-50 text-blue-700 border border-blue-200 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full flex items-center gap-1">
                            <i className="fa-solid fa-bolt text-[9px]"></i> Auto-Apply
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 line-clamp-2">{tmpl.description || "No description provided."}</p>

                      {/* Hover-reveal action buttons */}
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 absolute top-4 right-4 bg-white/80 backdrop-blur-sm p-1 rounded-lg border border-slate-100 shadow-sm">
                        <button onClick={() => handleEditClick(tmpl)} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors" title="Edit"><i className="fa-solid fa-pencil text-xs"></i></button>
                        <button onClick={() => setApplyOpen(tmpl.id)} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors" title="Apply"><i className="fa-solid fa-play text-[10px]"></i></button>
                        <button onClick={() => handleDelete(tmpl.id, tmpl.name)} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors" title="Delete"><i className="fa-solid fa-trash text-xs"></i></button>
                      </div>
                    </div>

                    {/* Card Body */}
                    <div className="p-5 flex-grow">
                      <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Branch Rules</div>
                      <div className="space-y-2">
                        {tmpl.branches.map((rule, idx) => (
                          <div key={idx} className={`bg-slate-50 rounded-lg px-3 py-2 border border-slate-100 flex items-center justify-between ${!rule.protection ? "opacity-75" : ""}`}>
                            <div className="flex items-center gap-3 min-w-0">
                              <i className="fa-solid fa-code-branch text-slate-400 text-xs flex-shrink-0"></i>
                              <span className="font-mono text-xs text-slate-700 font-medium truncate">{rule.branchNames.join(", ") || "unnamed"}</span>
                            </div>
                            {rule.protection ? (
                              <span className="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] px-2 py-0.5 rounded-md font-semibold whitespace-nowrap ml-2">
                                {protectionLabel(rule)}
                              </span>
                            ) : (
                              <span className="text-slate-400 border border-slate-200 text-[10px] px-2 py-0.5 rounded-md font-medium whitespace-nowrap bg-white ml-2">
                                No Protection
                              </span>
                            )}
                          </div>
                        ))}
                        {tmpl.branches.length === 0 && (
                          <div className="p-4 text-center border border-dashed border-slate-200 rounded-lg bg-slate-50/50">
                            <p className="text-xs text-slate-400 italic">No branch rules configured.</p>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Card Footer */}
                    <div className="border-t border-slate-100 bg-slate-50/50 px-5 py-3 mt-auto">
                      <span className="text-[11px] text-slate-400 font-medium">
                        Created by <span className="text-slate-600">{tmpl.createdBy}</span> on {new Date(tmpl.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}

                {/* "Create New" placeholder card */}
                <div
                  onClick={() => setCreateOpen(true)}
                  className="group border-2 border-dashed border-slate-200 rounded-2xl flex flex-col items-center justify-center p-8 hover:border-slate-300 hover:bg-slate-50 transition-all cursor-pointer h-full min-h-[200px]"
                >
                  <div className="w-12 h-12 rounded-full bg-slate-100 group-hover:bg-white group-hover:shadow-md flex items-center justify-center mb-3 transition-all duration-300">
                    <i className="fa-solid fa-plus text-slate-400 group-hover:text-slate-600"></i>
                  </div>
                  <span className="text-sm font-semibold text-slate-500 group-hover:text-slate-700">Create New Template</span>
                </div>
              </div>
            )}

            {!isLoading && !error && (!templates || templates.length === 0) && (
              <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
                <div className="bg-slate-50 rounded-full h-32 w-32 flex items-center justify-center mb-6 shadow-inner">
                  <i className="fa-solid fa-layer-group text-slate-200 text-5xl"></i>
                </div>
                <h2 className="text-2xl font-bold text-slate-800 mb-2">No Templates Yet</h2>
                <p className="text-slate-500 mb-8 text-center max-w-sm">Create your first repository initialization template to automate your workflow standards.</p>
                <button onClick={() => setCreateOpen(true)} className="bg-slate-900 hover:bg-slate-800 text-white px-6 py-3 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 font-medium">
                  Create Template
                </button>
              </div>
            )}
          </>
        )}

        {/* --- EXCLUSION LISTS TAB --- */}
        {activeTab === "exclusions" && (
          <>
            {exclusions && exclusions.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6 animate-fade-in">
                {exclusions.map(excl => {
                  const linkedTemplates = templates?.filter(t => t.exclusionLists?.includes(excl.id)) || [];
                  return (
                    <div key={excl.id} className="group bg-white rounded-2xl border border-slate-200 shadow-soft hover:shadow-lg hover:-translate-y-1 transition-all duration-300 flex flex-col h-full relative overflow-hidden">
                      {/* Header */}
                      <div className="px-5 py-5 border-b border-slate-100 bg-gradient-to-r from-white to-rose-50/30">
                        <div className="flex items-center gap-2 mb-1">
                          <i className="fa-solid fa-ban text-rose-500 text-sm"></i>
                          <h3 className="font-bold text-lg text-slate-800">{excl.name}</h3>
                        </div>
                        <p className="text-xs text-slate-500 line-clamp-2">{excl.description || "No description provided."}</p>

                        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200 absolute top-4 right-4 bg-white/80 backdrop-blur-sm p-1 rounded-lg border border-slate-100 shadow-sm">
                          <button onClick={() => handleEditExclClick(excl)} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:bg-blue-50 hover:text-blue-600 transition-colors"><i className="fa-solid fa-pencil text-xs"></i></button>
                          <button onClick={() => handleDeleteExcl(excl.id, excl.name)} className="w-7 h-7 flex items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-600 transition-colors"><i className="fa-solid fa-trash text-xs"></i></button>
                        </div>
                      </div>

                      {/* Body */}
                      <div className="p-5 flex-grow">
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Excluded Repositories ({excl.repos.length})</div>
                        <div className="flex flex-wrap gap-2 mb-4">
                          {excl.repos.slice(0, 8).map(r => (
                            <span key={r} className="px-2 py-1 bg-slate-100 text-[11px] text-slate-600 rounded-md border border-slate-200 font-mono flex items-center gap-1.5">
                              <i className="fa-regular fa-bookmark text-slate-400 text-[10px]"></i> {r}
                            </span>
                          ))}
                          {excl.repos.length > 8 && (
                            <span className="px-2 py-1 bg-slate-50 text-[11px] text-slate-500 rounded-md border border-slate-200 font-mono">+{excl.repos.length - 8} more</span>
                          )}
                          {excl.repos.length === 0 && <span className="text-xs text-slate-400 italic">No repositories selected</span>}
                        </div>

                        <div className="border-t border-slate-100 my-3"></div>

                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Linked Templates</div>
                        {linkedTemplates.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {linkedTemplates.map(t => (
                              <span key={t.id} className="bg-blue-50 text-blue-700 border border-blue-200 text-[11px] font-medium px-2 py-0.5 rounded-full">{t.name}</span>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400 italic">Not linked to any templates.</p>
                        )}

                        {(excl.forceOnNewTemplates || (excl.forceTemplateIds && excl.forceTemplateIds.length > 0)) && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {excl.forceOnNewTemplates && (
                              <span className="bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1">
                                <i className="fa-solid fa-lock text-[9px]"></i> Auto-forced on new templates
                              </span>
                            )}
                            {excl.forceTemplateIds && excl.forceTemplateIds.length > 0 && !excl.forceOnNewTemplates && (
                              <span className="bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1">
                                <i className="fa-solid fa-lock text-[9px]"></i> Forced on {excl.forceTemplateIds.length} template{excl.forceTemplateIds.length !== 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* "Create New" placeholder card */}
                <div
                  onClick={() => setCreateExclOpen(true)}
                  className="group border-2 border-dashed border-slate-200 rounded-2xl flex flex-col items-center justify-center p-8 hover:border-slate-300 hover:bg-slate-50 transition-all cursor-pointer h-full min-h-[200px]"
                >
                  <div className="w-12 h-12 rounded-full bg-slate-100 group-hover:bg-white group-hover:shadow-md flex items-center justify-center mb-3 transition-all duration-300">
                    <i className="fa-solid fa-ban text-slate-400 group-hover:text-slate-600"></i>
                  </div>
                  <span className="text-sm font-semibold text-slate-500 group-hover:text-slate-700">Create Exclusion List</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 animate-fade-in">
                <div className="bg-slate-50 rounded-full h-32 w-32 flex items-center justify-center mb-6 shadow-inner">
                  <i className="fa-solid fa-ban text-slate-200 text-5xl"></i>
                </div>
                <h2 className="text-2xl font-bold text-slate-800 mb-2">No Exclusion Lists</h2>
                <p className="text-slate-500 mb-8 text-center max-w-sm">Create exclusion lists to prevent templates from applying to specific repositories.</p>
                <button onClick={() => setCreateExclOpen(true)} className="bg-slate-900 hover:bg-slate-800 text-white px-6 py-3 rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 font-medium">
                  Create Exclusion List
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {/* CREATE TEMPLATE MODAL */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => { setCreateOpen(false); resetForm(); }}></div>
          
          <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-2xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">
            <div className="bg-white px-6 py-4 border-b border-gh-border flex justify-between items-center rounded-t-xl shrink-0">
              <h3 className="text-lg font-bold text-gh-textBase">
                {editingId ? "Edit Repo Init Template" : "Create Repo Init Template"}
              </h3>
              <button onClick={() => { setCreateOpen(false); resetForm(); }} className="text-gray-400 hover:text-gray-600 transition-colors">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            <div className="px-6 py-4 space-y-6 overflow-y-auto">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gh-textBase mb-1">Template Name</label>
                  <input 
                    type="text" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Python Data Service" 
                    className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase placeholder-gray-400 ring-1 ring-inset ring-gray-300 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gh-textBase mb-1">Description</label>
                  <textarea 
                    rows={2} 
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Briefly describe when to use this template..." 
                    className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset ring-gray-300 resize-none outline-none transition-all"
                  ></textarea>
                </div>
                
                <div className="flex items-center justify-between bg-gray-50 p-3 rounded-lg border border-gray-200">
                  <div>
                    <span className="block text-sm font-medium text-gh-textBase">Auto-apply to new repositories</span>
                    <span className="block text-xs text-gh-muted">Automatically use this template when a repo is created in the org.</span>
                  </div>
                  <div className="relative inline-block w-10 mr-2 align-middle select-none transition duration-200 ease-in">
                    <input 
                      type="checkbox" 
                      id="toggle" 
                      checked={autoApply}
                      onChange={(e) => setAutoApply(e.target.checked)}
                      className="toggle-checkbox absolute block w-5 h-5 rounded-full bg-white border-4 appearance-none cursor-pointer border-gray-300 transition-all duration-300 peer z-10"
                    />
                    <label htmlFor="toggle" className="toggle-label block overflow-hidden h-5 rounded-full bg-gray-300 cursor-pointer peer-checked:bg-gh-blue transition-colors duration-300"></label>
                  </div>
                </div>
              </div>

              <div className="bg-gray-50 p-4 rounded-lg border border-gray-200">
                <label className="block text-sm font-semibold text-gh-textBase mb-2">Exclusion Lists</label>
                <p className="text-xs text-gh-muted mb-3">Select exclusion lists to prevent this template from applying to specific repositories.</p>
                {exclusions && exclusions.length > 0 ? (() => {
                  const isNewTemplate = !editingId;
                  const forcedExcl = exclusions.filter(e =>
                    (e.forceOnNewTemplates && isNewTemplate) ||
                    (e.forceOnNewTemplates && !isNewTemplate) ||
                    ((e.forceTemplateIds || []).includes(editingId || ""))
                  );
                  const optionalExcl = exclusions.filter(e => !forcedExcl.some(f => f.id === e.id));
                  const forcedIds = forcedExcl.map(e => e.id);

                  if (!selectedExclusions.some(id => forcedIds.includes(id)) && forcedIds.length > 0) {
                    const merged = Array.from(new Set([...selectedExclusions, ...forcedIds]));
                    if (merged.length !== selectedExclusions.length) {
                      setTimeout(() => setSelectedExclusions(merged), 0);
                    }
                  }

                  return (
                    <div className="space-y-3 max-h-48 overflow-y-auto pr-2">
                      {forcedExcl.length > 0 && (
                        <div>
                          <div className="flex items-center gap-1.5 mb-2">
                            <i className="fa-solid fa-lock text-[10px] text-amber-500"></i>
                            <span className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">Forced</span>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {forcedExcl.map(excl => (
                              <div key={excl.id} className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded opacity-90">
                                <div className="flex items-center h-5">
                                  <input type="checkbox" checked disabled className="w-4 h-4 text-amber-500 border-amber-300 rounded cursor-not-allowed" />
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-xs font-medium text-amber-800 flex items-center gap-1">
                                    {excl.name}
                                    <i className="fa-solid fa-lock text-[8px] text-amber-400"></i>
                                  </span>
                                  <span className="text-[10px] text-amber-600">{excl.repos.length} repos &middot; Cannot be removed</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {optionalExcl.length > 0 && (
                        <div>
                          {forcedExcl.length > 0 && (
                            <div className="flex items-center gap-1.5 mb-2">
                              <span className="text-[10px] font-bold text-gh-muted uppercase tracking-wider">Optional</span>
                            </div>
                          )}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {optionalExcl.map(excl => (
                              <label key={excl.id} className="flex items-start gap-2 p-2 bg-white border border-gray-200 rounded cursor-pointer hover:border-gh-blue transition-colors group">
                                <div className="flex items-center h-5">
                                  <input
                                    type="checkbox"
                                    checked={selectedExclusions.includes(excl.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) {
                                        setSelectedExclusions([...selectedExclusions, excl.id]);
                                      } else {
                                        setSelectedExclusions(selectedExclusions.filter(id => id !== excl.id));
                                      }
                                    }}
                                    className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
                                  />
                                </div>
                                <div className="flex flex-col">
                                  <span className="text-xs font-medium text-gh-textBase group-hover:text-gh-blue transition-colors">{excl.name}</span>
                                  <span className="text-[10px] text-gh-muted">{excl.repos.length} repos</span>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })() : (
                  <p className="text-xs text-gh-muted italic">No exclusion lists found. Create one in the Exclusion Lists tab.</p>
                )}
              </div>

              <hr className="border-gh-border" />

              <div>
                <div className="flex justify-between items-end mb-3">
                  <label className="block text-sm font-bold text-gh-textBase">Branches</label>
                  <span className="text-xs text-gh-muted">Define the branch structure</span>
                </div>

                <div className="space-y-3">
                  {branchRules.map((rule, idx) => (
                    <div key={idx} className={`border rounded-lg p-4 transition-shadow ${
                      rule.protection ? 'border-gh-border bg-white shadow-sm ring-1 ring-black/5' : 'border-gh-border bg-gray-50/50 border-dashed'
                    }`}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1 relative flex items-center bg-gray-50 rounded-md border border-gray-300 shadow-sm focus-within:border-gh-blue focus-within:ring-1 focus-within:ring-gh-blue/30 overflow-hidden min-h-[36px] flex-wrap px-1.5 py-1 gap-1.5 transition-all">
                          <i className="fa-solid fa-code-branch text-gray-400 text-xs ml-2 flex-shrink-0"></i>
                          
                          {/* Tags */}
                          {rule.branchNames.map(branchName => (
                            <span key={branchName} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white text-gh-textBase border border-gray-200 shadow-sm text-sm font-mono whitespace-nowrap">
                              {branchName}
                              <button
                                type="button"
                                onClick={() => removeBranchFromRule(idx, branchName)}
                                className="text-gray-400 hover:text-gray-600 focus:outline-none"
                              >
                                <i className="fa-solid fa-xmark text-xs"></i>
                              </button>
                            </span>
                          ))}

                          {/* Input */}
                          <input 
                            type="text" 
                            value={rule.inputVal || ''}
                            onChange={(e) => updateRuleInput(idx, e.target.value)}
                            onKeyDown={(e) => handleRuleInputKeyDown(idx, e)}
                            placeholder={rule.branchNames.length === 0 ? "Branch name (e.g. dev) + Enter" : "Add another..."} 
                            className="flex-1 min-w-[120px] border-none focus:ring-0 sm:text-sm py-0.5 font-mono text-sm bg-transparent outline-none m-0 p-0 shadow-none placeholder-gray-400"
                          />
                        </div>
                        <button 
                          onClick={() => removeRule(idx)}
                          className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors flex-shrink-0"
                        >
                          <i className="fa-solid fa-trash-can text-sm"></i>
                        </button>
                      </div>
                      
                      {/* Base Branch Selector */}
                      <div className="border-t border-gray-100 pt-3 mt-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <i className="fa-solid fa-code-fork text-gray-400 text-xs"></i>
                          <span className="text-xs font-semibold text-gh-textMuted uppercase tracking-wider">Base branch for new branches</span>
                        </div>
                        <p className="text-[11px] text-gh-muted mb-2.5">Only applies when a branch doesn&apos;t exist yet and needs to be created.</p>
                        <div className="flex gap-2 mb-2">
                          <button
                            type="button"
                            onClick={() => {
                              const updated = [...branchRules];
                              updated[idx] = { ...rule, baseBranchMode: "default", baseBranch: undefined, onBaseBranchMissing: undefined };
                              setBranchRules(updated);
                            }}
                            className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-all flex items-center gap-1.5 ${
                              (!rule.baseBranchMode || rule.baseBranchMode === "default")
                                ? "bg-gh-blue text-white border-gh-blue shadow-sm"
                                : "bg-white text-gh-textMuted border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                            }`}
                          >
                            <i className="fa-solid fa-star text-[9px]"></i>
                            Default branch
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const updated = [...branchRules];
                              updated[idx] = { ...rule, baseBranchMode: "specific", baseBranch: rule.baseBranch || "", onBaseBranchMissing: rule.onBaseBranchMissing || "use_default" };
                              setBranchRules(updated);
                            }}
                            className={`px-3 py-1.5 text-xs font-semibold rounded-md border transition-all flex items-center gap-1.5 ${
                              rule.baseBranchMode === "specific"
                                ? "bg-gh-blue text-white border-gh-blue shadow-sm"
                                : "bg-white text-gh-textMuted border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                            }`}
                          >
                            <i className="fa-solid fa-crosshairs text-[9px]"></i>
                            Specific branch
                          </button>
                        </div>

                        {rule.baseBranchMode === "specific" && (
                          <div className="pl-4 border-l-2 border-gh-blue/20 space-y-3 mt-2">
                            <div>
                              <label className="block text-xs font-medium text-gh-textBase mb-1">Branch name</label>
                              <div className="relative">
                                <i className="fa-solid fa-code-branch absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs"></i>
                                <input
                                  type="text"
                                  value={rule.baseBranch || ""}
                                  onChange={(e) => {
                                    const updated = [...branchRules];
                                    updated[idx] = { ...rule, baseBranch: e.target.value };
                                    setBranchRules(updated);
                                  }}
                                  placeholder="e.g. develop, staging"
                                  className="w-full pl-8 pr-3 py-1.5 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-all"
                                />
                              </div>
                            </div>

                            <div>
                              <label className="block text-xs font-medium text-gh-textBase mb-1.5">If this branch can&apos;t be found</label>
                              <div className="space-y-1.5">
                                {([
                                  { value: "use_default" as const, icon: "fa-solid fa-arrow-rotate-left", label: "Fall back to default branch", desc: "Create from the repo's default branch instead" },
                                  { value: "skip_rule" as const, icon: "fa-solid fa-forward", label: "Skip this rule", desc: "Don't create these branches or apply protections" },
                                  { value: "undo_repo" as const, icon: "fa-solid fa-rotate-left", label: "Abort & undo entire repo", desc: "Undo everything the template did on this repo" },
                                ]).map(opt => (
                                  <label
                                    key={opt.value}
                                    className={`flex items-start gap-2.5 p-2 rounded-md border cursor-pointer transition-all ${
                                      (rule.onBaseBranchMissing || "use_default") === opt.value
                                        ? "border-gh-blue bg-blue-50/50 ring-1 ring-gh-blue/20"
                                        : "border-gray-200 bg-white hover:border-gray-300"
                                    }`}
                                  >
                                    <input
                                      type="radio"
                                      name={`fallback-${idx}`}
                                      checked={(rule.onBaseBranchMissing || "use_default") === opt.value}
                                      onChange={() => {
                                        const updated = [...branchRules];
                                        updated[idx] = { ...rule, onBaseBranchMissing: opt.value };
                                        setBranchRules(updated);
                                      }}
                                      className="mt-0.5 w-3.5 h-3.5 text-gh-blue border-gray-300 focus:ring-gh-blue"
                                    />
                                    <div className="flex-1">
                                      <div className="flex items-center gap-1.5">
                                        <i className={`${opt.icon} text-[10px] ${(rule.onBaseBranchMissing || "use_default") === opt.value ? "text-gh-blue" : "text-gray-400"}`}></i>
                                        <span className="text-xs font-semibold text-gh-textBase">{opt.label}</span>
                                      </div>
                                      <p className="text-[10px] text-gh-muted mt-0.5">{opt.desc}</p>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex flex-col border-t border-gray-100 pt-3 mt-3">
                        <div className="flex items-center justify-between">
                          <label className="inline-flex items-center cursor-pointer whitespace-nowrap shrink-0">
                            <input 
                              type="checkbox" 
                              checked={!!rule.protection} 
                              onChange={() => toggleRuleProtection(idx)}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-600 relative"></div>
                            <span className="ml-2 text-sm font-medium text-gh-textBase flex-1 pr-2">
                              {rule.protection ? (
                                <>Protect branches</>
                              ) : (
                                <span className="text-gray-500">Enable Protection</span>
                              )}
                            </span>
                          </label>

                          {rule.protection && (
                            <button
                              type="button"
                              onClick={() => setEditingRuleIdx(idx)}
                              className="px-3 py-1.5 text-xs font-semibold text-gh-blue hover:text-gh-blueHover bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition-colors flex items-center gap-1.5 shadow-sm"
                            >
                              <i className="fa-solid fa-sliders text-[10px]"></i> Configure Rules
                            </button>
                          )}
                        </div>

                        {rule.protection && (
                          <div className="mt-3 pl-4 border-l-2 border-gray-200 text-sm text-gh-muted">
                            {rule.protection.type === "ruleset_json" ? (
                              <span className="flex items-center gap-1.5 text-gh-textBase font-medium">
                                <i className="fa-solid fa-code text-gh-blue"></i>
                                Custom JSON Ruleset Configured
                              </span>
                            ) : rule.protection.type === "ruleset" ? (
                              <span className="flex items-center gap-1.5">
                                <i className="fa-solid fa-shield-halved text-gh-blue"></i>
                                Ruleset: {rule.protection.rulesetName || "Unnamed"}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1.5">
                                <i className="fa-solid fa-shield text-gh-blue"></i>
                                Classic Protection
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  <button 
                    onClick={addRule}
                    className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm font-medium text-gray-500 hover:text-gh-blue hover:border-gh-blue hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                  >
                    <i className="fa-solid fa-plus"></i> Add Branch
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 px-6 py-4 border-t border-gh-border flex justify-end gap-3 rounded-b-xl shrink-0">
              <button 
                onClick={() => { setCreateOpen(false); resetForm(); }} 
                className="px-4 py-2 border border-gh-border shadow-sm text-sm font-medium rounded-md text-gh-textBase bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateOrUpdate}
                disabled={!name || branchRules.some(r => r.inputVal && r.inputVal.trim() !== "") || branchRules.every((r) => r.branchNames.length === 0 && !r.inputVal.trim()) || branchRules.some(r => r.protection?.type === "ruleset" && !(r.protection.rulesetName?.trim())) || createMutation.isPending || updateMutation.isPending}
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-gh-blue hover:bg-gh-blueHover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50 disabled:opacity-50"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingId ? "Save Changes" : "Create Template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingRuleIdx !== null && branchRules[editingRuleIdx] && (
        <ProtectBranchModal
          isOpen={true}
          onClose={() => setEditingRuleIdx(null)}
          branch={branchRules[editingRuleIdx].branchNames.join(", ")}
          initialData={branchRules[editingRuleIdx].protection!}
          isTemplateMode={true}
          isSaving={false}
          onSave={(newProtection) => {
            const updated = [...branchRules];
            updated[editingRuleIdx].protection = newProtection;
            setBranchRules(updated);
            setEditingRuleIdx(null);
          }}
        />
      )}

      {/* APPLY TEMPLATE MODAL */}
      {applyOpen && (() => {
        const applyingTemplate = templates?.find(t => t.id === applyOpen);
        const excludedReposSet = new Set<string>();
        if (applyingTemplate?.exclusionLists) {
          applyingTemplate.exclusionLists.forEach(listId => {
            const excl = exclusions?.find(e => e.id === listId);
            if (excl) excl.repos.forEach(r => excludedReposSet.add(r));
          });
        }
        
        const availableRepos = repos?.filter(r => !excludedReposSet.has(r.name)) || [];
        const filteredAvailableRepos = availableRepos.filter(r => r.name.toLowerCase().includes(applySearch.toLowerCase()));
        
        return (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setApplyOpen(null)}></div>
            
            <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-3xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">
              <div className="bg-white px-6 py-5 border-b border-gh-border flex items-center gap-4 rounded-t-xl shrink-0">
                <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-blue-50 text-blue-600 border border-blue-100">
                  <i className="fa-solid fa-layer-group text-lg"></i>
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-bold text-gh-textBase tracking-tight">
                    Apply Template: {applyingTemplate?.name}
                  </h3>
                  <p className="text-sm text-gh-muted mt-0.5">Select repositories to apply this template's branches and protection rules.</p>
                </div>
              </div>

              <div className="px-6 py-5 flex-1 overflow-y-auto flex flex-col md:flex-row gap-6">
                {/* Left side: Repository selection */}
                <div className="flex-1 flex flex-col gap-3">
                  <label className="block text-sm font-semibold text-gh-textBase uppercase tracking-wide">Target Repositories</label>
                  <div className="relative">
                    <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                    <input 
                      type="text"
                      placeholder="Search repositories..."
                      value={applySearch}
                      onChange={e => setApplySearch(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-all"
                    />
                  </div>
                  
                  <div className="border border-gray-200 rounded-lg bg-white overflow-hidden flex flex-col flex-1 min-h-[250px] md:min-h-[300px]">
                    <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200 flex items-center justify-between sticky top-0 z-10">
                      <label className="flex items-center gap-2 cursor-pointer group">
                        <input 
                          type="checkbox" 
                          checked={filteredAvailableRepos.length > 0 && filteredAvailableRepos.every(r => applyRepos.includes(r.name))}
                          onChange={(e) => {
                            if (e.target.checked) {
                              const newSelected = new Set([...applyRepos, ...filteredAvailableRepos.map(r => r.name)]);
                              setApplyRepos(Array.from(newSelected));
                            } else {
                              const toRemove = new Set(filteredAvailableRepos.map(r => r.name));
                              setApplyRepos(applyRepos.filter(name => !toRemove.has(name)));
                            }
                          }}
                          className="w-4 h-4 text-gh-blue rounded border-gray-300 focus:ring-gh-blue transition-colors"
                        />
                        <span className="text-sm font-semibold text-gray-700 group-hover:text-gh-blue transition-colors">Select All (Visible)</span>
                      </label>
                      <span className="text-xs font-medium bg-blue-50 text-blue-700 px-2.5 py-0.5 rounded-full border border-blue-200">
                        {applyRepos.length} selected
                      </span>
                    </div>
                    <div className="overflow-y-auto p-1.5 flex-1">
                      {filteredAvailableRepos.map(r => (
                        <label key={r.name} className="flex items-center gap-3 px-3 py-2 hover:bg-blue-50/50 rounded-md cursor-pointer group transition-colors">
                          <input 
                            type="checkbox" 
                            checked={applyRepos.includes(r.name)}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setApplyRepos(prev => [...prev, r.name]);
                              } else {
                                setApplyRepos(prev => prev.filter(name => name !== r.name));
                              }
                            }}
                            className="w-4 h-4 text-gh-blue rounded border-gray-300 focus:ring-gh-blue transition-colors"
                          />
                          <i className="fa-solid fa-book-bookmark text-gray-400 group-hover:text-gh-blue transition-colors"></i>
                          <span className="text-sm text-gh-textBase font-medium truncate group-hover:text-gh-blue transition-colors">{r.name}</span>
                        </label>
                      ))}
                      {filteredAvailableRepos.length === 0 && (
                        <div className="px-4 py-8 text-center text-sm text-gh-muted italic flex flex-col items-center gap-2">
                          <i className="fa-solid fa-inbox text-2xl text-gray-300"></i>
                          No eligible repositories found matching "{applySearch}"
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Right side: Exclusions summary */}
                {excludedReposSet.size > 0 && (
                  <div className="w-full md:w-64 flex flex-col gap-3">
                    <label className="block text-sm font-semibold text-gh-textBase uppercase tracking-wide flex items-center gap-2">
                      <i className="fa-solid fa-ban text-red-500"></i>
                      Excluded
                    </label>
                    <div className="bg-red-50/50 border border-red-100 rounded-lg p-3 flex-1 overflow-y-auto min-h-[200px] md:min-h-[300px]">
                      <p className="text-xs text-red-800 mb-3 font-medium">
                        {excludedReposSet.size} repositories are excluded by linked exclusion lists and cannot be selected.
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {Array.from(excludedReposSet).map(r => (
                          <div key={r} className="flex items-center gap-2 text-xs text-red-700 bg-white border border-red-100 px-2 py-1.5 rounded-md shadow-sm">
                            <i className="fa-solid fa-lock text-red-400"></i>
                            <span className="truncate">{r}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="bg-gray-50 px-6 py-4 flex justify-end gap-3 border-t border-gh-border rounded-b-xl shrink-0">
                <button 
                  onClick={() => { setApplyOpen(null); setApplyRepos([]); setApplySearch(""); }} 
                  className="px-4 py-2 border border-gh-border shadow-sm text-sm font-medium rounded-md text-gh-textBase bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={handleApply}
                  disabled={applyRepos.length === 0 || applyMutation.isPending}
                  className="px-5 py-2 border border-transparent text-sm font-semibold rounded-md shadow-sm text-white bg-gh-blue hover:bg-gh-blueHover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50 disabled:opacity-50 transition-all active:scale-[0.98]"
                >
                  {applyMutation.isPending ? "Applying..." : `Apply to ${applyRepos.length} Repos`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* CREATE EXCLUSION LIST MODAL */}
      {createExclOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => { setCreateExclOpen(false); resetExclForm(); }}></div>
          
          <div className="bg-white rounded-xl shadow-modal border border-black/10 w-full max-w-xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">
            <div className="bg-white px-6 py-5 border-b border-gh-border flex justify-between items-center rounded-t-xl shrink-0">
              <h3 className="text-xl font-bold text-gh-textBase flex items-center gap-2">
                <i className="fa-solid fa-ban text-red-500"></i>
                {editingExclId ? "Edit Exclusion List" : "New Exclusion List"}
              </h3>
              <button onClick={() => { setCreateExclOpen(false); resetExclForm(); }} className="text-gray-400 hover:text-gray-600 transition-colors">
                <i className="fa-solid fa-xmark text-lg"></i>
              </button>
            </div>

            <div className="px-6 py-5 space-y-6 overflow-y-auto">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-gh-textBase mb-1.5">List Name <span className="text-red-500">*</span></label>
                  <input 
                    type="text" 
                    value={exclName}
                    onChange={(e) => setExclName(e.target.value)}
                    placeholder="e.g. Critical Infrastructure" 
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-all"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-gh-textBase mb-1.5">Description</label>
                  <input 
                    type="text" 
                    value={exclDescription}
                    onChange={(e) => setExclDescription(e.target.value)}
                    placeholder="Optional description" 
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-all"
                  />
                </div>
              </div>

              {/* Existing Repos */}
              <div className="border-t border-gh-border pt-5">
                <label className="block text-sm font-semibold text-gh-textBase mb-3">
                  Excluded Repositories
                  <span className="text-xs font-normal text-gh-muted ml-2">({exclRepos.length + exclCustomRepos.length} total)</span>
                </label>
                <div className="relative mb-3">
                  <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"></i>
                  <input 
                    type="text"
                    placeholder="Search existing repositories..."
                    value={exclSearch}
                    onChange={e => setExclSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue/50 focus:border-gh-blue transition-all"
                  />
                </div>
                
                <div className="border border-gray-200 rounded-lg bg-white overflow-hidden flex flex-col h-72">
                  {(() => {
                    const filtered = repos?.filter(r => r.name.toLowerCase().includes(exclSearch.toLowerCase())) || [];
                    const allSelected = filtered.length > 0 && filtered.every(r => exclRepos.includes(r.name));
                    return (
                      <>
                        <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between shrink-0">
                          <label className="flex items-center gap-2 cursor-pointer group">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  const newRepos = new Set([...exclRepos, ...filtered.map(r => r.name)]);
                                  setExclRepos(Array.from(newRepos));
                                } else {
                                  const toRemove = new Set(filtered.map(r => r.name));
                                  setExclRepos(exclRepos.filter(n => !toRemove.has(n)));
                                }
                              }}
                              className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500 transition-colors"
                            />
                            <span className="text-xs font-semibold text-gray-600 group-hover:text-red-600 transition-colors">
                              {allSelected ? "Deselect All" : "Select All"}{exclSearch ? " (Visible)" : ""}
                            </span>
                          </label>
                          <span className="text-[10px] font-medium bg-red-50 text-red-600 px-2 py-0.5 rounded-full border border-red-100">
                            {exclRepos.length} selected
                          </span>
                        </div>
                        <div className="overflow-y-auto p-1.5 flex-1">
                          {filtered.map(r => (
                            <label key={r.name} className="flex items-center gap-3 px-3 py-2 hover:bg-red-50/50 rounded-md cursor-pointer group transition-colors">
                              <input 
                                type="checkbox" 
                                checked={exclRepos.includes(r.name)}
                                onChange={(e) => {
                                  if (e.target.checked) setExclRepos(prev => [...prev, r.name]);
                                  else setExclRepos(prev => prev.filter(name => name !== r.name));
                                }}
                                className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500 transition-colors"
                              />
                              <i className={`fa-solid fa-book-bookmark ${exclRepos.includes(r.name) ? "text-red-400" : "text-gray-400"} group-hover:text-red-500 transition-colors`}></i>
                              <span className={`text-sm font-medium truncate transition-colors ${exclRepos.includes(r.name) ? "text-red-700" : "text-gh-textBase group-hover:text-red-600"}`}>{r.name}</span>
                            </label>
                          ))}
                          {filtered.length === 0 && (
                            <div className="px-4 py-8 text-center text-sm text-gh-muted italic">
                              No repositories found matching &ldquo;{exclSearch}&rdquo;
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* Custom / Future Repo Names */}
              <div className="border-t border-gh-border pt-5">
                <label className="block text-sm font-semibold text-gh-textBase mb-1">Custom Repository Names</label>
                <p className="text-xs text-gh-muted mb-3">Add names of repositories that don't exist yet. These will be excluded if they are created in the future.</p>
                <div className="flex flex-wrap gap-2 mb-2">
                  {exclCustomRepos.map(name => (
                    <span key={name} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-red-50 text-red-700 text-xs font-medium rounded-full border border-red-200">
                      {name}
                      <button onClick={() => setExclCustomRepos(prev => prev.filter(n => n !== name))} className="hover:text-red-900 transition-colors">
                        <i className="fa-solid fa-xmark text-[9px]"></i>
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="Type a repo name and press Enter..."
                  className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue/50 transition-all ${exclCustomPending ? "border-amber-400 focus:border-amber-500 bg-amber-50/30" : "border-gray-300 focus:border-gh-blue"}`}
                  onChange={(e) => setExclCustomPending(e.target.value.trim().length > 0)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const val = (e.target as HTMLInputElement).value.trim();
                      if (val && !exclCustomRepos.includes(val) && !exclRepos.includes(val)) {
                        setExclCustomRepos(prev => [...prev, val]);
                        (e.target as HTMLInputElement).value = "";
                        setExclCustomPending(false);
                      }
                    }
                  }}
                />
                {exclCustomPending && (
                  <p className="text-[11px] text-amber-600 mt-1 flex items-center gap-1">
                    <i className="fa-solid fa-triangle-exclamation text-[9px]"></i>
                    Press Enter to add this repo name before saving.
                  </p>
                )}
              </div>

              {/* Force-Apply Settings */}
              <div className="border-t border-gh-border pt-5">
                <label className="block text-sm font-semibold text-gh-textBase mb-1">Force-Apply Settings</label>
                <p className="text-xs text-gh-muted mb-4">Control which templates must always include this exclusion list. Forced exclusion lists cannot be removed from the template.</p>

                <label className="flex items-center gap-3 mb-4 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={exclForceOnNew}
                    onChange={e => setExclForceOnNew(e.target.checked)}
                    className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500 transition-colors"
                  />
                  <div>
                    <span className="text-sm font-medium text-gh-textBase group-hover:text-red-600 transition-colors">Force on all new templates</span>
                    <p className="text-[11px] text-gh-muted">Every template created in the future will automatically include this exclusion list and it cannot be removed.</p>
                  </div>
                </label>

                {templates && templates.length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-gh-textMuted uppercase tracking-wider mb-2">Force on existing templates</label>
                    <div className="border border-gray-200 rounded-lg bg-white overflow-hidden flex flex-col max-h-40">
                      <div className="overflow-y-auto p-1.5 flex-1">
                        {templates.map(tmpl => (
                          <label key={tmpl.id} className="flex items-center gap-3 px-3 py-2 hover:bg-red-50/50 rounded-md cursor-pointer group transition-colors">
                            <input
                              type="checkbox"
                              checked={exclForceTemplateIds.includes(tmpl.id)}
                              onChange={(e) => {
                                if (e.target.checked) setExclForceTemplateIds(prev => [...prev, tmpl.id]);
                                else setExclForceTemplateIds(prev => prev.filter(id => id !== tmpl.id));
                              }}
                              className="w-4 h-4 text-red-500 rounded border-gray-300 focus:ring-red-500 transition-colors"
                            />
                            <i className={`fa-solid fa-file-lines ${exclForceTemplateIds.includes(tmpl.id) ? "text-red-400" : "text-gray-400"} group-hover:text-red-500 transition-colors`}></i>
                            <span className={`text-sm font-medium truncate transition-colors ${exclForceTemplateIds.includes(tmpl.id) ? "text-red-700" : "text-gh-textBase group-hover:text-red-600"}`}>{tmpl.name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="bg-gray-50 px-6 py-4 flex justify-end gap-3 border-t border-gh-border rounded-b-xl shrink-0">
              <button 
                onClick={() => { setCreateExclOpen(false); resetExclForm(); }} 
                className="px-4 py-2 border border-gh-border shadow-sm text-sm font-medium rounded-md text-gh-textBase bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleCreateOrUpdateExcl}
                disabled={!exclName || (exclRepos.length === 0 && exclCustomRepos.length === 0) || exclCustomPending || createExclMutation.isPending || updateExclMutation.isPending}
                className="px-5 py-2 border border-transparent text-sm font-semibold rounded-md shadow-sm text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50 transition-all active:scale-[0.98]"
              >
                {createExclMutation.isPending || updateExclMutation.isPending ? "Saving..." : editingExclId ? "Save Changes" : "Create Exclusion List"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONFLICT RESOLUTION MODAL */}
      {conflictOpen && conflictItems.length > 0 && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConflictOpen(false)}>
          <div className="bg-white rounded-xl shadow-modal w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-gh-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center">
                  <i className="fa-solid fa-triangle-exclamation text-amber-600 text-sm"></i>
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gh-textBase">Template Conflicts Detected</h2>
                  <p className="text-xs text-gh-textSecondary mt-0.5">
                    {conflictItems.filter(c => !c.resolved).length} unresolved of {conflictItems.length} total
                  </p>
                </div>
              </div>
              <button onClick={() => setConflictOpen(false)} className="text-gh-textSecondary hover:text-gh-textBase transition-colors w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
              {(() => {
                const grouped = new Map<string, (typeof conflictItems)>();
                conflictItems.forEach((item, idx) => {
                  const key = item.repo;
                  if (!grouped.has(key)) grouped.set(key, []);
                  grouped.get(key)!.push({ ...item, _idx: idx } as any);
                });
                return Array.from(grouped.entries()).map(([repo, items]) => (
                  <div key={repo} className="border border-gh-border rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-2.5 border-b border-gh-border">
                      <span className="text-sm font-semibold text-gh-textBase"><i className="fa-solid fa-code-branch text-xs text-gh-textSecondary mr-1.5"></i>{repo}</span>
                    </div>
                    <div className="divide-y divide-gh-border">
                      {items.map((item: any) => (
                        <div key={item._idx} className={`px-4 py-3 ${item.resolved ? "bg-gray-50/50" : ""}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${item.type === "ruleset" ? "bg-blue-50 text-blue-700 border border-blue-200/60" : "bg-purple-50 text-purple-700 border border-purple-200/60"}`}>
                                  {item.type === "ruleset" ? "Ruleset" : "Classic"}
                                </span>
                                <span className="text-sm font-medium text-gh-textBase truncate">{item.name}</span>
                                {item.resolved && (
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${item.resolved === "override" ? "bg-red-50 text-red-700 border border-red-200/60" : "bg-gray-100 text-gray-600 border border-gray-200/60"}`}>
                                    {item.resolved === "override" ? "Overridden" : "Skipped"}
                                  </span>
                                )}
                              </div>
                              <button
                                className="text-[11px] font-medium text-gh-blue hover:text-gh-blueHover mt-0.5 flex items-center gap-1"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setExpandedConflicts(prev => {
                                    const next = new Set(prev);
                                    next.has(item._idx) ? next.delete(item._idx) : next.add(item._idx);
                                    return next;
                                  });
                                }}
                              >
                                <i className={`fa-solid fa-chevron-${expandedConflicts.has(item._idx) ? 'down' : 'right'} text-[8px]`}></i>
                                {expandedConflicts.has(item._idx) ? "Hide" : "View"} {item.differences.length} difference{item.differences.length !== 1 ? "s" : ""}
                              </button>
                              {expandedConflicts.has(item._idx) && (() => {
                                const rows = buildConflictComparison(item.type, item.existingConfig, item.templateConfig);
                                return (
                                  <div className="mt-2 border border-gh-border rounded-md overflow-hidden text-xs">
                                    <table className="w-full">
                                      <thead>
                                        <tr className="bg-gray-50 border-b border-gh-border">
                                          <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-gh-muted uppercase tracking-wider">Setting</th>
                                          <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-red-500 uppercase tracking-wider">Existing</th>
                                          <th className="px-3 py-1.5 text-left text-[10px] font-semibold text-green-600 uppercase tracking-wider">Template</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-gh-border">
                                        {rows.map((r, ri) => (
                                          <tr key={ri} className="hover:bg-amber-50/30">
                                            <td className="px-3 py-1.5 font-medium text-gh-textBase">{r.label}</td>
                                            <td className="px-3 py-1.5 text-red-600 bg-red-50/30 font-mono">{r.existing}</td>
                                            <td className="px-3 py-1.5 text-green-700 bg-green-50/30 font-mono">{r.template}</td>
                                          </tr>
                                        ))}
                                        {rows.length === 0 && (
                                          <tr><td colSpan={3} className="px-3 py-2 text-gh-muted text-center">No structured differences found</td></tr>
                                        )}
                                      </tbody>
                                    </table>
                                  </div>
                                );
                              })()}
                            </div>
                            {!item.resolved && (
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  onClick={() => handleResolveConflict(item._idx, "skip")}
                                  disabled={item.resolving}
                                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-gh-border text-gh-textSecondary bg-white hover:bg-gray-50 disabled:opacity-50 transition-colors"
                                >
                                  Skip
                                </button>
                                <button
                                  onClick={() => handleResolveConflict(item._idx, "override")}
                                  disabled={item.resolving}
                                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors"
                                >
                                  {item.resolving ? "..." : "Override"}
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ));
              })()}
            </div>

            <div className="bg-gray-50 px-6 py-3 flex items-center justify-between border-t border-gh-border rounded-b-xl shrink-0">
              <p className="text-xs text-gh-textSecondary">Closing this popup leaves unresolved conflicts "on hold" in Activity.</p>
              <div className="flex items-center gap-2">
                {conflictItems.some(c => !c.resolved) && (
                  <>
                    <button
                      onClick={() => handleResolveAll("skip")}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-gh-border text-gh-textSecondary bg-white hover:bg-gray-50 transition-colors"
                    >
                      Skip All
                    </button>
                    <button
                      onClick={() => handleResolveAll("override")}
                      className="px-3 py-1.5 text-xs font-medium rounded-md border border-transparent text-white bg-red-600 hover:bg-red-700 transition-colors"
                    >
                      Override All
                    </button>
                  </>
                )}
                <button
                  onClick={() => setConflictOpen(false)}
                  className="px-4 py-1.5 text-xs font-medium rounded-md border border-gh-border text-gh-textBase bg-white hover:bg-gray-50 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* SNACKBAR */}
      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`px-4 py-3 rounded-lg shadow-modal flex items-center gap-3 text-sm font-medium text-white ${
            snack.severity === 'success' ? 'bg-gh-green' : 'bg-gh-red'
          }`}>
            <i className={`fa-solid ${snack.severity === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'} text-lg`}></i>
            {snack.msg}
            <button onClick={() => setSnack(null)} className="ml-2 text-white/70 hover:text-white transition-colors">
              <i className="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
