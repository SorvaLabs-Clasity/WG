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
import { useRepos } from "../hooks/useRepos";
import type { BranchRule } from "../types/Template";

const EMPTY_RULE: BranchRule = {
  branchName: "",
  protection: null,
};

const DEFAULT_PROTECTION: NonNullable<BranchRule["protection"]> = {
  requirePr: true,
  requiredApprovals: 1,
  dismissStaleReviews: true,
  requireCodeOwnerReviews: false,
  requireConversationResolution: false,
  requireStatusChecks: true,
  strictStatusChecks: true,
  requireSignedCommits: false,
  requireLinearHistory: false,
  enforceAdmins: true,
  preventForcePush: true,
  preventDeletion: true,
};

export default function TemplatesPage() {
  const { user } = useAuth();
  const { data: templates, isLoading, error } = useTemplates();
  const { data: repos } = useRepos();
  const createMutation = useCreateTemplate();
  const updateMutation = useUpdateTemplate();
  const deleteMutation = useDeleteTemplate();
  const applyMutation = useApplyTemplate();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [applyOpen, setApplyOpen] = useState<string | null>(null);
  const [applyRepo, setApplyRepo] = useState("");
  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  // Create form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [autoApply, setAutoApply] = useState(false);
  const [branchRules, setBranchRules] = useState<BranchRule[]>([
    { branchName: "main", protection: { ...DEFAULT_PROTECTION, requiredApprovals: 2 } },
    { branchName: "develop", protection: null },
  ]);

  const resetForm = () => {
    setName("");
    setDescription("");
    setAutoApply(false);
    setBranchRules([
      { branchName: "main", protection: { ...DEFAULT_PROTECTION, requiredApprovals: 2 } },
      { branchName: "develop", protection: null },
    ]);
    setEditingId(null);
  };

  const handleEditClick = (tmpl: any) => {
    setName(tmpl.name);
    setDescription(tmpl.description);
    setAutoApply(tmpl.autoApplyOnNewRepo);
    // Deep clone the rules so we don't accidentally mutate the cached ones
    setBranchRules(JSON.parse(JSON.stringify(tmpl.branches)));
    setEditingId(tmpl.id);
    setCreateOpen(true);
  };

  const handleCreateOrUpdate = () => {
    const validRules = branchRules.filter((r) => r.branchName.trim());
    if (!name || validRules.length === 0) return;

    if (editingId) {
      updateMutation.mutate(
        { id: editingId, data: { name, description, branches: validRules, autoApplyOnNewRepo: autoApply } },
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
        { name, description, branches: validRules, autoApplyOnNewRepo: autoApply },
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
    if (!applyOpen || !applyRepo) return;
    applyMutation.mutate(
      { templateId: applyOpen, repo: applyRepo },
      {
        onSuccess: (result) => {
          const msg = `Created: [${result.created.join(", ")}], Protected: [${result.protected.join(", ")}]${result.errors.length ? `, Errors: ${result.errors.length}` : ""}`;
          setSnack({ msg, severity: result.errors.length ? "error" : "success" });
          setApplyOpen(null);
          setApplyRepo("");
        },
        onError: (err) => setSnack({ msg: (err as Error).message, severity: "error" }),
      }
    );
  };

  const addRule = () => setBranchRules([...branchRules, { ...EMPTY_RULE }]);

  const removeRule = (idx: number) =>
    setBranchRules(branchRules.filter((_, i) => i !== idx));

  const updateRuleName = (idx: number, val: string) => {
    const updated = [...branchRules];
    updated[idx] = { ...updated[idx], branchName: val };
    setBranchRules(updated);
  };

  const toggleRuleProtection = (idx: number) => {
    const updated = [...branchRules];
    updated[idx] = {
      ...updated[idx],
      protection: updated[idx].protection ? null : { ...DEFAULT_PROTECTION },
    };
    setBranchRules(updated);
  };

  const updateRuleProtectionField = (idx: number, field: keyof NonNullable<BranchRule["protection"]>, val: any) => {
    const updated = [...branchRules];
    if (updated[idx].protection) {
      updated[idx] = {
        ...updated[idx],
        protection: { ...updated[idx].protection!, [field]: val },
      };
    }
    setBranchRules(updated);
  };

  return (
    <div className="bg-gh-light text-gh-text antialiased min-h-screen flex flex-col relative pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 pb-32 animate-fade-in">
        
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase tracking-tight">Repo Init Templates</h1>
            <p className="text-gh-muted text-sm mt-1">Define branch structures and protection rules to enforce standards across your organization.</p>
          </div>
          <button 
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-2 bg-gh-blue hover:bg-gh-blueHover text-white px-4 py-2 rounded-md text-sm font-semibold shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50"
          >
            <i className="fa-solid fa-plus text-xs"></i>
            New Template
          </button>
        </div>

        {isLoading && (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-md mb-6">
            <p className="text-red-700">Failed to load templates: {(error as Error).message}</p>
          </div>
        )}

        {!isLoading && !error && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {templates?.map((tmpl) => (
              <div key={tmpl.id} className="bg-white rounded-lg border border-gh-border p-0 hover:border-gh-blue hover:shadow-card transition-all group">
                <div className="p-5 border-b border-gh-border bg-gradient-to-r from-white to-gray-50/50 rounded-t-lg">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-gh-textBase">{tmpl.name}</h3>
                        {tmpl.autoApplyOnNewRepo && (
                          <span className="bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase tracking-wide flex items-center gap-1">
                            <i className="fa-solid fa-bolt"></i> Auto-Apply
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gh-muted mt-1 leading-relaxed">{tmpl.description || "No description provided."}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button 
                        onClick={() => handleEditClick(tmpl)}
                        className="p-1.5 text-gh-muted hover:text-gh-blue hover:bg-blue-50 rounded transition-colors" 
                        title="Edit Template"
                      >
                        <i className="fa-solid fa-pen"></i>
                      </button>
                      <button 
                        onClick={() => setApplyOpen(tmpl.id)}
                        className="p-1.5 text-gh-muted hover:text-gh-blue hover:bg-blue-50 rounded transition-colors" 
                        title="Apply Template"
                      >
                        <i className="fa-solid fa-play"></i>
                      </button>
                      <button 
                        onClick={() => handleDelete(tmpl.id, tmpl.name)}
                        className="p-1.5 text-gh-muted hover:text-gh-red hover:bg-red-50 rounded transition-colors" 
                        title="Delete Template"
                      >
                        <i className="fa-regular fa-trash-can"></i>
                      </button>
                    </div>
                  </div>
                </div>

                <div className="p-5">
                  <p className="text-xs font-semibold text-gh-muted uppercase tracking-wider mb-3">Branch Rules</p>
                  <div className="space-y-2">
                    {tmpl.branches.map((rule) => (
                      <div key={rule.branchName} className="flex items-center justify-between text-sm bg-gray-50 border border-gray-100 rounded px-3 py-2">
                        <span className="font-mono font-medium text-gh-textBase">
                          <i className="fa-solid fa-code-branch text-gh-muted mr-2 text-xs"></i>
                          {rule.branchName}
                        </span>
                        {rule.protection ? (
                          <span className="inline-flex items-center gap-1.5 bg-green-50 text-green-700 border border-green-200 px-2 py-0.5 rounded text-xs font-medium">
                            <i className="fa-solid fa-shield-halved text-[10px]"></i> 
                            {rule.protection.requiredApprovals} {rule.protection.requiredApprovals === 1 ? 'Approval' : 'Approvals'}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-gh-muted border border-gh-border px-2 py-0.5 rounded text-xs">
                            Unprotected
                          </span>
                        )}
                      </div>
                    ))}
                    {tmpl.branches.length === 0 && (
                      <p className="text-sm text-gh-muted italic">No branches defined.</p>
                    )}
                  </div>
                </div>
                
                <div className="px-5 py-3 border-t border-gh-border bg-gray-50/50 rounded-b-lg">
                  <p className="text-xs text-gh-muted flex items-center gap-1">
                    <i className="fa-regular fa-clock"></i> 
                    Created by <strong className="font-medium text-gh-textBase">{tmpl.createdBy}</strong> on {new Date(tmpl.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* CREATE TEMPLATE MODAL */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setCreateOpen(false)}></div>
          
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

              <hr className="border-gh-border" />

              <div>
                <div className="flex justify-between items-end mb-3">
                  <label className="block text-sm font-bold text-gh-textBase">Branch Rules</label>
                  <span className="text-xs text-gh-muted">Define the branch structure</span>
                </div>

                <div className="space-y-3">
                  {branchRules.map((rule, idx) => (
                    <div key={idx} className={`border rounded-lg p-4 transition-shadow ${
                      rule.protection ? 'border-gh-border bg-white shadow-sm ring-1 ring-black/5' : 'border-gh-border bg-gray-50/50 border-dashed'
                    }`}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className="flex-1 relative">
                          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                            <i className="fa-solid fa-code-branch text-gray-400 text-xs"></i>
                          </div>
                          <input 
                            type="text" 
                            value={rule.branchName}
                            onChange={(e) => updateRuleName(idx, e.target.value)}
                            placeholder="Branch name (e.g. dev)" 
                            className="pl-8 block w-full rounded-md border-gray-300 shadow-sm focus:border-gh-blue focus:ring-gh-blue/30 sm:text-sm py-1.5 font-mono text-sm bg-gray-50 ring-1 ring-inset ring-gray-200 outline-none"
                          />
                        </div>
                        <button 
                          onClick={() => removeRule(idx)}
                          className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-red-50 transition-colors"
                        >
                          <i className="fa-solid fa-trash-can text-sm"></i>
                        </button>
                      </div>
                      
                      <div className="flex items-center justify-between border-t border-gray-100 pt-3">
                        <label className="inline-flex items-center cursor-pointer">
                          <input 
                            type="checkbox" 
                            checked={!!rule.protection} 
                            onChange={() => toggleRuleProtection(idx)}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-green-600 relative"></div>
                          <span className="ml-2 text-sm font-medium text-gh-textBase">
                            {rule.protection ? (
                              <>Enable Protection for <span className="font-mono">{rule.branchName || 'branch'}</span></>
                            ) : (
                              <span className="text-gray-500">Enable Protection</span>
                            )}
                          </span>
                        </label>
                        
                        {rule.protection && (
                          <div className="mt-4 pt-4 border-t border-gray-100 space-y-3">
                            <div className="flex items-center justify-between">
                              <label className="text-xs font-semibold text-gh-textBase">Required Approvals</label>
                              <select 
                                value={rule.protection.requiredApprovals}
                                onChange={(e) => updateRuleProtectionField(idx, 'requiredApprovals', Number(e.target.value))}
                                className="block w-32 pl-2 pr-8 py-1 text-xs border-gray-300 focus:outline-none focus:ring-gh-blue focus:border-gh-blue rounded-md bg-white ring-1 ring-inset ring-gray-200"
                              >
                                {[1, 2, 3, 4, 5].map(n => (
                                  <option key={n} value={n}>{n} required</option>
                                ))}
                              </select>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
                              {[
                                { field: 'dismissStaleReviews', label: 'Dismiss stale reviews', desc: 'When new commits are pushed' },
                                { field: 'requireCodeOwnerReviews', label: 'Require Code Owner review', desc: 'If code owner is specified' },
                                { field: 'requireConversationResolution', label: 'Require conversation resolution', desc: 'All comments must be resolved' },
                                { field: 'requireStatusChecks', label: 'Require status checks', desc: 'Checks must pass' },
                                { field: 'strictStatusChecks', label: 'Require up to date branch', desc: 'Before merging' },
                                { field: 'requireSignedCommits', label: 'Require signed commits', desc: 'All commits must be signed' },
                                { field: 'requireLinearHistory', label: 'Require linear history', desc: 'Prevent merge commits' },
                                { field: 'enforceAdmins', label: 'Enforce for admins', desc: 'Rules apply to admins too' },
                                { field: 'preventForcePush', label: 'Prevent force pushing', desc: 'Block force pushes' },
                                { field: 'preventDeletion', label: 'Prevent deletion', desc: 'Block branch deletion' },
                              ].map(({ field, label, desc }) => (
                                <label key={field} className="flex items-start gap-2 cursor-pointer group/chk">
                                  <div className="flex items-center h-5">
                                    <input
                                      type="checkbox"
                                      checked={!!rule.protection?.[field as keyof NonNullable<BranchRule["protection"]>]}
                                      onChange={(e) => updateRuleProtectionField(idx, field as any, e.target.checked)}
                                      className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
                                    />
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="text-xs font-medium text-gh-textBase group-hover/chk:text-gh-blue transition-colors">{label}</span>
                                    <span className="text-[10px] text-gh-muted">{desc}</span>
                                  </div>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  <button 
                    onClick={addRule}
                    className="w-full py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm font-medium text-gray-500 hover:text-gh-blue hover:border-gh-blue hover:bg-blue-50 transition-all flex items-center justify-center gap-2"
                  >
                    <i className="fa-solid fa-plus"></i> Add Branch Rule
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
                disabled={!name || branchRules.every((r) => !r.branchName.trim()) || createMutation.isPending || updateMutation.isPending}
                className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-gh-blue hover:bg-gh-blueHover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50 disabled:opacity-50"
              >
                {createMutation.isPending || updateMutation.isPending ? "Saving..." : editingId ? "Save Changes" : "Create Template"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* APPLY TEMPLATE MODAL */}
      {applyOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-gray-900/60 backdrop-blur-sm animate-fade-in" onClick={() => setApplyOpen(null)}></div>
          
          <div className="bg-white rounded-lg shadow-modal border border-black/10 w-full max-w-md relative z-10 animate-slide-up flex flex-col">
            <div className="px-6 py-5">
              <div className="flex items-start gap-4">
                <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-blue-100 text-blue-600">
                  <i className="fa-solid fa-layer-group text-lg"></i>
                </div>
                <div className="flex-1">
                  <h3 className="text-lg font-bold text-gh-textBase">
                    Apply "{templates?.find(t => t.id === applyOpen)?.name}" Template
                  </h3>
                  <div className="mt-2 text-sm text-gh-muted">
                    <p>Select a repository to apply this template's branches and protection rules. This may overwrite existing settings.</p>
                  </div>
                  
                  <div className="mt-4">
                    <label className="block text-xs font-semibold text-gh-textBase uppercase tracking-wide mb-1">Target Repository</label>
                    <select 
                      value={applyRepo}
                      onChange={(e) => setApplyRepo(e.target.value)}
                      className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-gh-blue outline-none sm:text-sm rounded-md ring-1 ring-inset ring-gray-300 bg-white"
                    >
                      <option value="" disabled>Select a repo...</option>
                      {repos?.map(r => (
                        <option key={r.name} value={r.name}>{r.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-gray-50 px-6 py-3 flex justify-end gap-3 border-t border-gh-border rounded-b-lg">
              <button 
                onClick={() => setApplyOpen(null)} 
                className="inline-flex justify-center rounded-md border border-gray-300 shadow-sm px-4 py-2 bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200"
              >
                Cancel
              </button>
              <button 
                onClick={handleApply}
                disabled={!applyRepo || applyMutation.isPending}
                className="inline-flex justify-center rounded-md border border-transparent shadow-sm px-4 py-2 bg-gh-blue text-sm font-medium text-white hover:bg-gh-blueHover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50 disabled:opacity-50"
              >
                {applyMutation.isPending ? "Applying..." : "Apply Template"}
              </button>
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
