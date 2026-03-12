import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchRepoRulesets } from "../api/branches";
import { useAllBranchProtections, useProtectBranch, useDeleteBranchProtection, useDeleteRepoRuleset, useImportRepoRuleset, useBranches } from "../hooks/useBranches";
import ProtectBranchModal, { DEFAULT_PROTECTION } from "./ProtectBranchModal";
import type { BranchRule } from "../types/Template";

export default function RepoProtections({ repo }: { repo: string }) {
  const { data: rulesets, isLoading: rulesetsLoading } = useQuery({
    queryKey: ["rulesets", repo],
    queryFn: () => fetchRepoRulesets(repo),
  });

  const { data: classicProtections, isLoading: classicLoading } = useAllBranchProtections(repo);
  const { data: branches } = useBranches(repo);
  const protectMutation = useProtectBranch(repo);
  const deleteClassicMutation = useDeleteBranchProtection(repo);
  const deleteRulesetMutation = useDeleteRepoRuleset(repo);
  const importMutation = useImportRepoRuleset(repo);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingBranch, setEditingBranch] = useState<string | null>(null);
  const [editingData, setEditingData] = useState<NonNullable<BranchRule["protection"]> | undefined>(undefined);
  const [isCreating, setIsCreating] = useState(false);

  const [snack, setSnack] = useState<{ msg: string; severity: "success" | "error" } | null>(null);

  const handleEditRuleset = (rs: any) => {
    const rulesList = rs.rules || [];
    const hasRule = (type: string) => rulesList.some((r: any) => r.type === type);
    const getRule = (type: string) => rulesList.find((r: any) => r.type === type);
    
    const prRule = getRule('pull_request');
    const statusRule = getRule('required_status_checks');

    const targetBranches = rs.conditions?.ref_name?.include?.map((inc: string) => inc.replace('refs/heads/', '')).join(', ') || "";

    const mapped: NonNullable<BranchRule["protection"]> = {
      ...DEFAULT_PROTECTION,
      type: "ruleset",
      requirePr: !!prRule,
      requiredApprovals: prRule?.parameters?.required_approving_review_count || 1,
      dismissStaleReviews: prRule?.parameters?.dismiss_stale_reviews_on_push || false,
      requireCodeOwnerReviews: prRule?.parameters?.require_code_owner_review || false,
      requireConversationResolution: prRule?.parameters?.required_review_thread_resolution || false,
      requireStatusChecks: !!statusRule,
      strictStatusChecks: statusRule?.parameters?.strict_required_status_checks_policy || false,
      preventDeletion: hasRule('deletion'),
      preventForcePush: hasRule('non_fast_forward'),
      requireLinearHistory: hasRule('required_linear_history'),
      requireSignedCommits: hasRule('required_signatures'),
      enforceAdmins: rs.bypass_actors?.length === 0,
    };
    
    setEditingData(mapped);
    setEditingBranch(targetBranches);
    setIsCreating(false);
    setEditModalOpen(true);
  };

  const handleEditClassic = (branch: string, protectionData: any) => {
    const mapped: NonNullable<BranchRule["protection"]> = {
      ...DEFAULT_PROTECTION,
      type: "classic",
      requirePr: !!protectionData.required_pull_request_reviews,
      requiredApprovals: protectionData.required_pull_request_reviews?.required_approving_review_count || 1,
      dismissStaleReviews: protectionData.required_pull_request_reviews?.dismiss_stale_reviews || false,
      requireCodeOwnerReviews: protectionData.required_pull_request_reviews?.require_code_owner_reviews || false,
      requireStatusChecks: !!protectionData.required_status_checks,
      strictStatusChecks: protectionData.required_status_checks?.strict || false,
      enforceAdmins: protectionData.enforce_admins?.enabled || false,
      requireLinearHistory: protectionData.required_linear_history?.enabled || false,
      requireSignedCommits: protectionData.required_signatures?.enabled || false,
      preventForcePush: !protectionData.allow_force_pushes?.enabled,
      preventDeletion: !protectionData.allow_deletions?.enabled,
      requireConversationResolution: protectionData.required_conversation_resolution?.enabled || false,
    };
    
    setEditingData(mapped);
    setEditingBranch(branch);
    setIsCreating(false);
    setEditModalOpen(true);
  };

  const handleCreateProtection = () => {
    setEditingBranch("");
    setEditingData(undefined);
    setIsCreating(true);
    setEditModalOpen(true);
  };

  const handleSaveProtection = (rules: NonNullable<BranchRule["protection"]>, targetBranch: string) => {
    if (!targetBranch) return;
    
    const branchToUpdate = targetBranch.split(',')[0].trim();

    protectMutation.mutate(
      { branch: branchToUpdate, protection: rules },
      {
        onSuccess: () => {
          setSnack({ msg: `Protection applied to "${branchToUpdate}"`, severity: "success" });
          setEditModalOpen(false);
          setEditingBranch(null);
          setIsCreating(false);
        },
        onError: (err) => {
          setSnack({ msg: (err as Error).message, severity: "error" });
        },
      }
    );
  };

  const handleImportJson = (parsedJson: any) => {
    importMutation.mutate(parsedJson, {
      onSuccess: () => {
        setSnack({ msg: `Ruleset imported successfully`, severity: "success" });
        setEditModalOpen(false);
        setEditingBranch(null);
        setIsCreating(false);
      },
      onError: (err: any) => {
        setSnack({ msg: err?.message || "Failed to import ruleset.", severity: "error" });
      },
    });
  };

  const handleDeleteRuleset = (id: number, name: string) => {
    if (!confirm(`Are you sure you want to delete the ruleset "${name}"?`)) return;
    deleteRulesetMutation.mutate(id);
  };

  const handleDeleteClassic = (branch: string) => {
    if (!confirm(`Are you sure you want to remove classic branch protection from "${branch}"?`)) return;
    deleteClassicMutation.mutate(branch);
  };

  if (rulesetsLoading || classicLoading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gh-border p-6 flex justify-center items-center h-48">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gh-blue"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Action Bar */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gh-textBase flex items-center gap-2">
          <i className="ph ph-shield-check text-gh-textMuted text-xl"></i>
          Rules & Protections
        </h2>
        <div className="flex items-center gap-3">
          <button
            onClick={handleCreateProtection}
            className="bg-gh-blue hover:bg-gh-blueHover text-white px-3.5 py-1.5 rounded-md flex items-center gap-2 text-sm font-medium transition-all shadow-subtle active:scale-[0.98]"
          >
            <i className="ph-bold ph-plus text-base"></i>
            New Protection Rule
          </button>
        </div>
      </div>

      {/* Rulesets Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gh-border overflow-hidden">
        <div className="px-5 py-4 border-b border-gh-border bg-gray-50/50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gh-textBase flex items-center gap-2">
            <i className="fa-solid fa-layer-group text-gh-blue"></i>
            Repository Rulesets
          </h3>
          <span className="bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200">
            {rulesets?.length || 0}
          </span>
        </div>
        <div className="p-0">
          {rulesets && rulesets.length > 0 ? (
            <ul className="divide-y divide-gh-border">
              {rulesets.map((rs: any) => (
                <li key={rs.id} className="px-5 py-4 hover:bg-gray-50 transition-colors group">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-gh-textBase text-sm">{rs.name}</span>
                    <div className="flex items-center gap-3">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2">
                        <button 
                          onClick={() => handleEditRuleset(rs)}
                          className="text-xs font-semibold text-gh-blue hover:text-gh-blueHover flex items-center gap-1"
                        >
                          <i className="fa-solid fa-pen text-[10px]"></i> Edit
                        </button>
                        <button 
                          onClick={() => handleDeleteRuleset(rs.id, rs.name)}
                          disabled={deleteRulesetMutation.isPending}
                          className="text-xs font-semibold text-red-500 hover:text-red-700 flex items-center gap-1 ml-1 disabled:opacity-50"
                        >
                          <i className="fa-solid fa-trash-can text-[10px]"></i> Delete
                        </button>
                      </div>
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${
                        rs.enforcement === 'active' ? 'bg-green-50 text-green-700 border border-green-200' : 
                        rs.enforcement === 'evaluate' ? 'bg-yellow-50 text-yellow-700 border border-yellow-200' : 
                        'bg-gray-100 text-gray-600 border border-gray-200'
                      }`}>
                        {rs.enforcement === 'active' && <i className="fa-solid fa-check-circle text-[10px]"></i>}
                        {rs.enforcement}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <div className="text-xs text-gh-textBase font-mono flex items-center gap-2 flex-wrap">
                      <span className="text-gh-muted text-[11px] uppercase font-sans font-semibold tracking-wider">Target:</span>
                      {rs.conditions?.ref_name?.include?.map((inc: string) => (
                        <span key={inc} className="bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded">
                          {inc.replace('refs/heads/', '')}
                        </span>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center">
              <i className="fa-solid fa-layer-group text-gray-300 text-3xl mb-3"></i>
              <p className="text-sm text-gh-muted">No rulesets configured</p>
            </div>
          )}
        </div>
      </div>

      {/* Classic Protections Card */}
      <div className="bg-white rounded-xl shadow-sm border border-gh-border overflow-hidden">
        <div className="px-5 py-4 border-b border-gh-border bg-gray-50/50 flex justify-between items-center">
          <h3 className="text-base font-semibold text-gh-textBase flex items-center gap-2">
            <i className="fa-solid fa-shield-halved text-gh-blue"></i>
            Classic Protections
          </h3>
          <span className="bg-gray-100 text-gray-600 px-2.5 py-0.5 rounded-full text-xs font-medium border border-gray-200">
            {Object.keys(classicProtections || {}).length}
          </span>
        </div>
        <div className="p-0">
          {classicProtections && Object.keys(classicProtections).length > 0 ? (
            <ul className="divide-y divide-gh-border">
              {Object.entries(classicProtections).map(([branch, protection]: [string, any]) => (
                <li key={branch} className="px-5 py-4 hover:bg-gray-50 transition-colors group">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono font-semibold text-gh-textBase text-sm">
                      <i className="fa-solid fa-code-branch text-gh-muted mr-1.5 text-[10px]"></i>
                      {branch}
                    </span>
                    <div className="flex items-center gap-3">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2">
                        <button 
                          onClick={() => handleEditClassic(branch, protection)}
                          className="text-xs font-semibold text-gh-blue hover:text-gh-blueHover flex items-center gap-1"
                        >
                          <i className="fa-solid fa-pen text-[10px]"></i> Edit
                        </button>
                        <button 
                          onClick={() => handleDeleteClassic(branch)}
                          disabled={deleteClassicMutation.isPending}
                          className="text-xs font-semibold text-red-500 hover:text-red-700 flex items-center gap-1 ml-1 disabled:opacity-50"
                        >
                          <i className="fa-solid fa-trash-can text-[10px]"></i> Delete
                        </button>
                      </div>
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700 border border-green-200">
                        <i className="fa-solid fa-check-circle text-[10px]"></i> Active
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 mt-2">
                    {protection.required_pull_request_reviews && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-users text-[10px]"></i>
                        Requires {protection.required_pull_request_reviews.required_approving_review_count} PR approvals
                      </div>
                    )}
                    {protection.required_status_checks && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-list-check text-[10px]"></i>
                        Status checks required
                      </div>
                    )}
                    {protection.enforce_admins?.enabled && (
                      <div className="text-xs text-gh-muted flex items-center gap-2">
                        <i className="fa-solid fa-user-shield text-[10px]"></i>
                        Enforced for admins
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-5 py-8 text-center">
              <i className="fa-solid fa-shield-halved text-gray-300 text-3xl mb-3"></i>
              <p className="text-sm text-gh-muted">No classic protections</p>
            </div>
          )}
        </div>
      </div>

      {editModalOpen && (
        <ProtectBranchModal
          isOpen={editModalOpen}
          onClose={() => {
            setEditModalOpen(false);
            setEditingBranch(null);
            setIsCreating(false);
          }}
          branch={editingBranch || ""}
          branches={branches?.map(b => b.name) || []}
          initialData={editingData}
          onSave={handleSaveProtection}
          onImportJson={handleImportJson}
          isSaving={protectMutation.isPending || importMutation.isPending}
          isCreating={isCreating}
        />
      )}

      {snack && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] animate-slide-up">
          <div className={`px-4 py-3 rounded-lg shadow-modal flex items-center gap-3 text-sm font-medium text-white ${
            snack.severity === 'success' ? 'bg-[#1a7f37]' : 'bg-[#cf222e]'
          }`}>
            <i className={`ph-fill ${snack.severity === 'success' ? 'ph-check-circle' : 'ph-warning-circle'} text-lg`}></i>
            {snack.msg}
            <button onClick={() => setSnack(null)} className="ml-2 text-white/70 hover:text-white">
              <i className="ph ph-x"></i>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
