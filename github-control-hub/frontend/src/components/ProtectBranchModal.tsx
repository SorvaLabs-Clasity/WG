import { useState, useEffect } from "react";
import type { BranchRule } from "../types/Template";

export const DEFAULT_PROTECTION: NonNullable<BranchRule["protection"]> = {
  type: "classic",
  requirePr: true,
  requiredApprovals: 1,
  dismissStaleReviews: true,
  requireCodeOwnerReviews: false,
  requireLastPushApproval: false,
  requireConversationResolution: false,
  allowedMergeMethods: [],
  requireStatusChecks: true,
  strictStatusChecks: true,
  doNotRequireStatusChecksOnCreation: false,
  statusCheckContexts: [],
  requireDeployments: false,
  requiredDeploymentEnvironments: [],
  requireSignedCommits: false,
  requireLinearHistory: false,
  enforceAdmins: true,
  preventForcePush: true,
  preventDeletion: true,
  restrictCreations: false,
  restrictUpdates: false,
  requireCodeScanning: false,
  codeScanningTool: "CodeQL",
  codeScanningAlertsThreshold: "errors",
  codeScanningSecurityAlertsThreshold: "high_or_higher",
  enforcement: "active",
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

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group/chk">
      <div className="flex items-center h-5 mt-0.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
        />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-gh-textBase group-hover/chk:text-gh-blue transition-colors">{label}</span>
        <span className="text-[11px] text-gh-muted leading-snug">{desc}</span>
      </div>
    </label>
  );
}

function Section({ title, icon, children, defaultOpen = false }: { title: string; icon: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group/section border border-gray-200 rounded-lg overflow-hidden" open={defaultOpen}>
      <summary className="px-4 py-3 bg-gray-50 cursor-pointer hover:bg-gray-100 transition-colors list-none flex items-center gap-2 select-none">
        <i className={`ph-bold ph-caret-right text-xs text-gray-400 group-open/section:rotate-90 transition-transform`}></i>
        <i className={`${icon} text-gray-500 text-sm`}></i>
        <span className="text-sm font-semibold text-gh-textBase">{title}</span>
      </summary>
      <div className="p-4 space-y-4 border-t border-gray-200 bg-white">
        {children}
      </div>
    </details>
  );
}

function TagInput({ tags, onChange, placeholder }: { tags: string[]; onChange: (tags: string[]) => void; placeholder: string }) {
  const [input, setInput] = useState("");
  const addTag = () => {
    const val = input.trim();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInput("");
  };
  return (
    <div>
      <div className="flex gap-2 mb-2 flex-wrap">
        {tags.map(tag => (
          <span key={tag} className="inline-flex items-center gap-1 text-xs bg-gray-100 border border-gray-200 px-2 py-1 rounded-md font-mono text-gh-textBase">
            {tag}
            <button type="button" onClick={() => onChange(tags.filter(t => t !== tag))} className="text-gray-400 hover:text-red-500">
              <i className="ph-bold ph-x text-[10px]"></i>
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }}
          placeholder={placeholder}
          className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue"
        />
        <button type="button" onClick={addTag} className="px-3 py-1.5 text-xs font-semibold bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200 transition-colors">
          Add
        </button>
      </div>
    </div>
  );
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

  const update = (field: string, val: any) => {
    setProtectRules(prev => ({ ...prev, [field]: val }));
  };

  if (!isOpen) return null;

  const isRuleset = protectRules.type === "ruleset";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-[12px] shadow-modal border border-black/10 w-full max-w-[680px] relative z-10 animate-slide-up overflow-hidden flex flex-col max-h-[90vh]">
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

        <div className="p-6 space-y-5 overflow-y-auto">
          {/* Type Selector */}
          {!hideTypeSelector && (
            <div className="flex items-center justify-between border-b border-gray-100 pb-4">
              <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-md border border-gray-200 w-fit">
                <button
                  type="button"
                  onClick={() => update('type', 'classic')}
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
                  onClick={() => update('type', 'ruleset')}
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

          {/* Ruleset Name & Enforcement (ruleset only) */}
          {isRuleset && (
            <div className="grid grid-cols-2 gap-4 border-b border-gray-100 pb-4">
              <div>
                <label className="text-xs font-semibold text-gh-muted uppercase tracking-wider block mb-1.5">Ruleset Name</label>
                <input
                  type="text"
                  value={protectRules.rulesetName || ""}
                  onChange={e => update("rulesetName", e.target.value)}
                  placeholder={`Ruleset for ${branch}`}
                  className="w-full px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gh-muted uppercase tracking-wider block mb-1.5">Enforcement Status</label>
                <select
                  value={protectRules.enforcement || "active"}
                  onChange={e => update("enforcement", e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue"
                >
                  <option value="active">Active</option>
                  <option value="evaluate">Evaluate (dry-run)</option>
                  <option value="disabled">Disabled</option>
                </select>
              </div>
            </div>
          )}

          {/* Branch Rules */}
          <div className="space-y-3">
            <h4 className="text-xs font-bold text-gh-muted uppercase tracking-wider">Branch Rules</h4>

            {/* Restrict Operations (ruleset only) */}
            {isRuleset && (
              <Section title="Restrict Operations" icon="ph-fill ph-lock-key" defaultOpen={!!(protectRules.restrictCreations || protectRules.restrictUpdates || protectRules.preventDeletion)}>
                <div className="space-y-3">
                  <Toggle
                    checked={!!protectRules.restrictCreations}
                    onChange={v => update("restrictCreations", v)}
                    label="Restrict creations"
                    desc="Only allow users with bypass permission to create matching refs."
                  />
                  <Toggle
                    checked={!!protectRules.restrictUpdates}
                    onChange={v => update("restrictUpdates", v)}
                    label="Restrict updates"
                    desc="Only allow users with bypass permission to update matching refs."
                  />
                  <Toggle
                    checked={protectRules.preventDeletion}
                    onChange={v => update("preventDeletion", v)}
                    label="Restrict deletions"
                    desc="Only allow users with bypass permissions to delete matching refs."
                  />
                </div>
              </Section>
            )}

            {/* Commit Requirements */}
            <Section title="Commit Requirements" icon="ph-fill ph-git-commit" defaultOpen={!!(protectRules.requireLinearHistory || protectRules.requireSignedCommits)}>
              <div className="space-y-3">
                <Toggle
                  checked={protectRules.requireLinearHistory}
                  onChange={v => update("requireLinearHistory", v)}
                  label="Require linear history"
                  desc="Prevent merge commits from being pushed to matching refs."
                />
                <Toggle
                  checked={protectRules.requireSignedCommits}
                  onChange={v => update("requireSignedCommits", v)}
                  label="Require signed commits"
                  desc="Commits pushed to matching refs must have verified signatures."
                />
              </div>
            </Section>

            {/* Deployments */}
            {isRuleset && (
              <Section title="Require Deployments to Succeed" icon="ph-fill ph-rocket-launch" defaultOpen={!!protectRules.requireDeployments}>
                <Toggle
                  checked={!!protectRules.requireDeployments}
                  onChange={v => update("requireDeployments", v)}
                  label="Require deployments to succeed"
                  desc="Choose which environments must be successfully deployed to before refs can be pushed."
                />
                {protectRules.requireDeployments && (
                  <div className="ml-7 mt-2">
                    <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Deployment Environments</label>
                    <TagInput
                      tags={protectRules.requiredDeploymentEnvironments || []}
                      onChange={tags => update("requiredDeploymentEnvironments", tags)}
                      placeholder="e.g. production, staging"
                    />
                  </div>
                )}
              </Section>
            )}

            {/* Pull Request Requirements */}
            <Section title="Require a Pull Request Before Merging" icon="ph-fill ph-git-pull-request" defaultOpen={protectRules.requirePr}>
              <Toggle
                checked={protectRules.requirePr}
                onChange={v => update("requirePr", v)}
                label="Require a pull request before merging"
                desc="All commits must be made via a pull request before they can be merged."
              />
              {protectRules.requirePr && (
                <div className="ml-7 space-y-4 mt-2">
                  <div>
                    <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Approvals</label>
                    <select
                      value={protectRules.requiredApprovals}
                      onChange={(e) => update('requiredApprovals', Number(e.target.value))}
                      className="block w-40 pl-2 pr-8 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue"
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                        <option key={n} value={n}>{n} {n === 1 ? "approval" : "approvals"}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-3">
                    <Toggle
                      checked={protectRules.dismissStaleReviews}
                      onChange={v => update("dismissStaleReviews", v)}
                      label="Dismiss stale pull request approvals when new commits are pushed"
                      desc="New, reviewable commits pushed will dismiss previous PR review approvals."
                    />
                    <Toggle
                      checked={protectRules.requireCodeOwnerReviews}
                      onChange={v => update("requireCodeOwnerReviews", v)}
                      label="Require review from Code Owners"
                      desc="Require an approving review in PRs that modify files with a designated code owner."
                    />
                    <Toggle
                      checked={!!protectRules.requireLastPushApproval}
                      onChange={v => update("requireLastPushApproval", v)}
                      label="Require approval of the most recent reviewable push"
                      desc="The most recent push must be approved by someone other than the person who pushed it."
                    />
                    <Toggle
                      checked={protectRules.requireConversationResolution}
                      onChange={v => update("requireConversationResolution", v)}
                      label="Require conversation resolution before merging"
                      desc="All conversations on code must be resolved before a PR can be merged."
                    />
                  </div>
                  {isRuleset && (
                    <div>
                      <label className="text-xs font-semibold text-gh-muted block mb-2">Allowed Merge Methods</label>
                      <div className="flex gap-4">
                        {(["merge", "squash", "rebase"] as const).map(method => (
                          <label key={method} className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={(protectRules.allowedMergeMethods || []).includes(method)}
                              onChange={e => {
                                const current = protectRules.allowedMergeMethods || [];
                                update("allowedMergeMethods", e.target.checked ? [...current, method] : current.filter(m => m !== method));
                              }}
                              className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue"
                            />
                            <span className="text-sm capitalize">{method === "merge" ? "Merge commit" : method === "squash" ? "Squash" : "Rebase"}</span>
                          </label>
                        ))}
                      </div>
                      <p className="text-[11px] text-gh-muted mt-1">When merging PRs, you can allow any combination. At least one must be enabled if set.</p>
                    </div>
                  )}
                </div>
              )}
            </Section>

            {/* Status Checks */}
            <Section title="Require Status Checks to Pass" icon="ph-fill ph-check-circle" defaultOpen={protectRules.requireStatusChecks}>
              <Toggle
                checked={protectRules.requireStatusChecks}
                onChange={v => update("requireStatusChecks", v)}
                label="Require status checks to pass"
                desc="Choose which status checks must pass before the ref is updated."
              />
              {protectRules.requireStatusChecks && (
                <div className="ml-7 space-y-3 mt-2">
                  <Toggle
                    checked={protectRules.strictStatusChecks}
                    onChange={v => update("strictStatusChecks", v)}
                    label="Require branches to be up to date before merging"
                    desc="PRs targeting a matching branch must be tested with the latest code."
                  />
                  {isRuleset && (
                    <Toggle
                      checked={!!protectRules.doNotRequireStatusChecksOnCreation}
                      onChange={v => update("doNotRequireStatusChecksOnCreation", v)}
                      label="Do not require status checks on creation"
                      desc="Allow repositories and branches to be created if a check would otherwise prohibit it."
                    />
                  )}
                  <div>
                    <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Status Checks</label>
                    <TagInput
                      tags={protectRules.statusCheckContexts || []}
                      onChange={tags => update("statusCheckContexts", tags)}
                      placeholder="e.g. build, test, lint"
                    />
                  </div>
                </div>
              )}
            </Section>

            {/* Force Push & Deletion (classic mode shows these here) */}
            {!isRuleset && (
              <Section title="Push & Deletion Restrictions" icon="ph-fill ph-shield-warning" defaultOpen={protectRules.preventForcePush || protectRules.preventDeletion}>
                <div className="space-y-3">
                  <Toggle
                    checked={protectRules.preventForcePush}
                    onChange={v => update("preventForcePush", v)}
                    label="Block force pushes"
                    desc="Prevent users with push access from force pushing to refs."
                  />
                  <Toggle
                    checked={protectRules.preventDeletion}
                    onChange={v => update("preventDeletion", v)}
                    label="Prevent deletion"
                    desc="Block branch deletion."
                  />
                </div>
              </Section>
            )}

            {/* Force Push (ruleset mode) */}
            {isRuleset && (
              <Section title="Block Force Pushes" icon="ph-fill ph-shield-warning" defaultOpen={protectRules.preventForcePush}>
                <Toggle
                  checked={protectRules.preventForcePush}
                  onChange={v => update("preventForcePush", v)}
                  label="Block force pushes"
                  desc="Prevent users with push access from force pushing to refs."
                />
              </Section>
            )}

            {/* Code Scanning (ruleset only) */}
            {isRuleset && (
              <Section title="Require Code Scanning Results" icon="ph-fill ph-bug" defaultOpen={!!protectRules.requireCodeScanning}>
                <Toggle
                  checked={!!protectRules.requireCodeScanning}
                  onChange={v => update("requireCodeScanning", v)}
                  label="Require code scanning results"
                  desc="Code scanning must be enabled and have results for both the commit and the reference being updated."
                />
                {protectRules.requireCodeScanning && (
                  <div className="ml-7 space-y-3 mt-2">
                    <div>
                      <label className="text-xs font-semibold text-gh-muted block mb-1.5">Tool</label>
                      <input
                        type="text"
                        value={protectRules.codeScanningTool || "CodeQL"}
                        onChange={e => update("codeScanningTool", e.target.value)}
                        className="w-48 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Alerts Threshold</label>
                        <select
                          value={protectRules.codeScanningAlertsThreshold || "errors"}
                          onChange={e => update("codeScanningAlertsThreshold", e.target.value)}
                          className="w-full px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue"
                        >
                          <option value="none">None</option>
                          <option value="errors">Errors</option>
                          <option value="errors_and_warnings">Errors & Warnings</option>
                          <option value="all">All</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Security Threshold</label>
                        <select
                          value={protectRules.codeScanningSecurityAlertsThreshold || "high_or_higher"}
                          onChange={e => update("codeScanningSecurityAlertsThreshold", e.target.value)}
                          className="w-full px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue"
                        >
                          <option value="none">None</option>
                          <option value="critical">Critical</option>
                          <option value="high_or_higher">High or Higher</option>
                          <option value="medium_or_higher">Medium or Higher</option>
                          <option value="all">All</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </Section>
            )}

            {/* Enforce for Admins */}
            <Section title="Enforcement" icon="ph-fill ph-crown" defaultOpen={protectRules.enforceAdmins}>
              <Toggle
                checked={protectRules.enforceAdmins}
                onChange={v => update("enforceAdmins", v)}
                label={isRuleset ? "Do not allow bypassing above rules" : "Enforce for admins"}
                desc={isRuleset ? "When enabled, admins and repository owners cannot bypass these rules." : "Include administrators in these protection rules."}
              />
            </Section>
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
