import { useState, useEffect } from "react";
import type { BranchRule } from "../types/Template";

export const DEFAULT_PROTECTION: NonNullable<BranchRule["protection"]> = {
  type: "classic",
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

interface ProtectBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  branch: string;
  initialData?: NonNullable<BranchRule["protection"]>;
  onSave: (rules: NonNullable<BranchRule["protection"]>) => void;
  isSaving: boolean;
  hideTypeSelector?: boolean;
}

export default function ProtectBranchModal({
  isOpen,
  onClose,
  branch,
  initialData,
  onSave,
  isSaving,
  hideTypeSelector = false,
}: ProtectBranchModalProps) {
  const [protectRules, setProtectRules] = useState(DEFAULT_PROTECTION);

  useEffect(() => {
    if (isOpen) {
      setProtectRules(initialData || { ...DEFAULT_PROTECTION });
    }
  }, [isOpen, initialData]);

  const updateProtectRule = (field: keyof NonNullable<BranchRule["protection"]>, val: any) => {
    setProtectRules(prev => ({ ...prev, [field]: val }));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-[12px] shadow-modal border border-black/10 w-full max-w-[600px] relative z-10 animate-slide-up overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white pt-5 shrink-0">
          <h3 className="text-lg font-bold text-gray-900 tracking-tight">
            Protect Branch: <span className="font-mono bg-gray-100 px-1 rounded text-gh-blue">{branch}</span>
          </h3>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-black/5 transition-colors absolute right-4 top-4"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>
        
        <div className="p-6 space-y-6 overflow-y-auto">
          <div className="space-y-4">
            {!hideTypeSelector && (
              <div className="flex items-center justify-between border-b border-gray-100 pb-4">
                <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-md border border-gray-200 w-fit">
                  <button
                    type="button"
                    onClick={() => updateProtectRule('type', 'classic')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                      protectRules.type === 'classic' 
                        ? 'bg-white shadow-sm text-gh-textBase border border-gray-200/50' 
                        : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                    }`}
                  >
                    Classic Branch API
                  </button>
                  <button
                    type="button"
                    onClick={() => updateProtectRule('type', 'ruleset')}
                    className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                      protectRules.type === 'ruleset' 
                        ? 'bg-white shadow-sm text-gh-textBase border border-gray-200/50' 
                        : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                    }`}
                  >
                    Repository Ruleset API
                  </button>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between border-b border-gray-100 pb-4">
              <label className="text-sm font-semibold text-gh-textBase">Required Approvals</label>
              <select 
                value={protectRules.requiredApprovals}
                onChange={(e) => updateProtectRule('requiredApprovals', Number(e.target.value))}
                className="block w-32 pl-2 pr-8 py-1.5 text-sm border-gray-300 focus:outline-none focus:ring-gh-blue focus:border-gh-blue rounded-md bg-white ring-1 ring-inset ring-gray-200"
              >
                {[1, 2, 3, 4, 5].map(n => (
                  <option key={n} value={n}>{n} required</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 pb-2">
              {[
                { field: 'dismissStaleReviews', label: 'Dismiss stale reviews', desc: 'When new commits are pushed' },
                { field: 'preventForcePush', label: 'Prevent force pushing', desc: 'Block force pushes' },
                { field: 'preventDeletion', label: 'Prevent deletion', desc: 'Block branch deletion' },
              ].map(({ field, label, desc }) => (
                <label key={field} className="flex items-start gap-3 cursor-pointer group/chk">
                  <div className="flex items-center h-5 mt-0.5">
                    <input
                      type="checkbox"
                      checked={!!protectRules[field as keyof NonNullable<BranchRule["protection"]>]}
                      onChange={(e) => updateProtectRule(field as any, e.target.checked)}
                      className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
                    />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-gh-textBase group-hover/chk:text-gh-blue transition-colors">{label}</span>
                    <span className="text-[11px] text-gh-muted">{desc}</span>
                  </div>
                </label>
              ))}
            </div>

            <details className="group/details mt-2">
              <summary className="text-sm font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1.5 select-none pt-2 border-t border-gray-100">
                <i className="ph-bold ph-caret-right text-xs group-open/details:rotate-90 transition-transform"></i>
                Advanced Settings
              </summary>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 pt-4 mt-2">
                {[
                  { field: 'requireCodeOwnerReviews', label: 'Require Code Owner review', desc: 'If code owner is specified' },
                  { field: 'requireConversationResolution', label: 'Require conversation resolution', desc: 'All comments must be resolved' },
                  { field: 'requireStatusChecks', label: 'Require status checks', desc: 'Checks must pass' },
                  { field: 'strictStatusChecks', label: 'Require up to date branch', desc: 'Before merging' },
                  { field: 'requireSignedCommits', label: 'Require signed commits', desc: 'All commits must be signed' },
                  { field: 'requireLinearHistory', label: 'Require linear history', desc: 'Prevent merge commits' },
                  { field: 'enforceAdmins', label: 'Enforce for admins', desc: 'Rules apply to admins too' },
                ].map(({ field, label, desc }) => (
                  <label key={field} className="flex items-start gap-3 cursor-pointer group/chk">
                    <div className="flex items-center h-5 mt-0.5">
                      <input
                        type="checkbox"
                        checked={!!protectRules[field as keyof NonNullable<BranchRule["protection"]>]}
                        onChange={(e) => updateProtectRule(field as any, e.target.checked)}
                        className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-gh-textBase group-hover/chk:text-gh-blue transition-colors">{label}</span>
                      <span className="text-[11px] text-gh-muted">{desc}</span>
                    </div>
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gh-border bg-gray-50/50 flex items-center justify-end gap-3 rounded-b-[12px] shrink-0">
          <button 
            onClick={onClose}
            className="px-4 py-2 text-[13px] font-semibold text-gh-textBase bg-white border border-gh-border hover:bg-gray-50 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200"
          >
            Cancel
          </button>
          <button 
            onClick={() => onSave(protectRules)}
            disabled={isSaving}
            className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50"
          >
            {isSaving ? "Applying..." : "Apply Protection"}
          </button>
        </div>
      </div>
    </div>
  );
}
