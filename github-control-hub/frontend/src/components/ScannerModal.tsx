import { useState, useEffect } from "react";
import { useCreateScanner, useUpdateScanner } from "../hooks/useScanners";
import { useRepos } from "../hooks/useRepos";
import type { ScannerCondition } from "../types/Scanner";
import { QUERY_OPTIONS, paramNoun } from "../utils/queryOptions";
import { TagInput } from "./TagInput";

export default function ScannerModal({ isOpen, onClose, scanner }: any) {
  const createMutation = useCreateScanner();
  const updateMutation = useUpdateScanner();
  const { data: repos } = useRepos();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [targetReposType, setTargetReposType] = useState<"all" | "selected">("all");
  const [selectedRepos, setSelectedRepos] = useState<string[]>([]);
  const [includeFutureRepos, setIncludeFutureRepos] = useState(false);
  const [conditions, setConditions] = useState<(ScannerCondition & { inputVal?: string })[]>([]);
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (scanner) {
      setName(scanner.name);
      setDescription(scanner.description);
      if (scanner.targetRepos === "all") {
        setTargetReposType("all");
        setSelectedRepos([]);
        setIncludeFutureRepos(false);
      } else {
        setTargetReposType("selected");
        setSelectedRepos(scanner.targetRepos);
        setIncludeFutureRepos(!!scanner.includeFutureRepos);
      }
      setConditions(scanner.conditions.map((c: any) => ({ ...c, inputVal: "" })));
    } else {
      setName("");
      setDescription("");
      setTargetReposType("all");
      setSelectedRepos([]);
      setIncludeFutureRepos(false);
      setConditions([{
        type: "branch_protection",
        branchPatterns: ["main"],
        inputVal: "",
        requiresProtection: true,
        protectionType: "any",
        rules: { requirePr: true, minApprovals: 1 }
      }]);
    }
    setErrorMsg("");
  }, [scanner]);

  const handleSave = () => {
    const hasPendingInput = conditions.some(c => c.inputVal && c.inputVal.trim() !== "");
    if (hasPendingInput) {
      setErrorMsg("Please press Enter to add all typed branch patterns before saving.");
      return;
    }
    
    if (targetReposType === "selected" && selectedRepos.length === 0) {
      setErrorMsg("Please select at least one repository, or choose 'All repositories'.");
      return;
    }
    
    setErrorMsg("");

    const finalTargetRepos = targetReposType === "all" ? "all" : selectedRepos;

    const data = {
      name,
      description,
      targetRepos: finalTargetRepos,
      includeFutureRepos: targetReposType === "selected" ? includeFutureRepos : undefined,
      conditions: conditions.map(({ inputVal, ...rest }) => rest)
    } as any;

    if (scanner) {
      updateMutation.mutate({ id: scanner.id, data }, { onSuccess: onClose });
    } else {
      createMutation.mutate(data, { onSuccess: onClose });
    }
  };

  const addCondition = () => {
    setConditions([...conditions, {
      type: "branch_protection",
      branchPatterns: [],
      inputVal: "",
      requiresProtection: true,
      protectionType: "any",
      rules: {}
    }]);
  };

  const removeCondition = (idx: number) => {
    setConditions(conditions.filter((_, i) => i !== idx));
  };

  const updateCondition = (idx: number, field: string, val: any) => {
    const newConds = [...conditions];
    (newConds[idx] as any)[field] = val;
    setConditions(newConds);
  };

  const updateRule = (idx: number, field: string, val: any) => {
    const newConds = [...conditions];
    if (!newConds[idx].rules) newConds[idx].rules = {};
    (newConds[idx].rules as any)[field] = val;
    setConditions(newConds);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 -[3px] animate-fade-in" onClick={onClose}></div>
        <div className="bg-white dark:bg-paper rounded-none shadow-modal border border-black/10 dark:border-rule w-full max-w-3xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">
        
        <div className="px-6 py-4 border-b border-rule dark:border-rule flex items-center justify-between bg-white dark:bg-paper pt-5 shrink-0 rounded-t-[12px]">
          <h3 className="display text-[1.1875rem] text-ink">
            {scanner ? "Edit Scanner" : "Create Compliance Scanner"}
          </h3>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 dark:text-slate-500 hover:text-gray-900 dark:hover:text-ink hover:bg-black/5 dark:hover:bg-ink/5 transition-colors"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          <div className="space-y-4">
            <div>
              <label className="caps block mb-1">Scanner Name</label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. SOC2 Branch Compliance" 
                className="field-line text-[13.5px] w-full"
              />
            </div>
            <div>
              <label className="caps block mb-1">Description</label>
              <input 
                type="text" 
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this verify?" 
                className="field-line text-[13.5px] w-full"
              />
            </div>
            <div className="border border-rule dark:border-rule rounded-lg p-4 bg-gray-50/30 dark:bg-paper-2/30">
              <label className="caps block mb-3">Target Repositories</label>
              
              <div className="space-y-4">
                <label className="flex items-start gap-2 cursor-pointer group/radio">
                  <input 
                    type="radio" 
                    name="targetType"
                    checked={targetReposType === "all"}
                    onChange={() => setTargetReposType("all")}
                    className="accent-ink w-4 h-4 cursor-pointer mt-0.5"
                  />
                  <div>
                    <span className="block text-sm font-medium text-gh-textBase dark:text-slate-200">All repositories (auto-include future repos)</span>
                    <span className="block text-[11px] text-gh-muted dark:text-slate-400 mt-0.5">Scan all current and future repositories in the organization automatically.</span>
                  </div>
                </label>
                
                <label className="flex items-start gap-2 cursor-pointer group/radio">
                  <input 
                    type="radio" 
                    name="targetType"
                    checked={targetReposType === "selected"}
                    onChange={() => setTargetReposType("selected")}
                    className="accent-ink w-4 h-4 cursor-pointer mt-0.5"
                  />
                  <div>
                    <span className="block text-sm font-medium text-gh-textBase dark:text-slate-200">Selected repositories</span>
                    <span className="block text-[11px] text-gh-muted dark:text-slate-400 mt-0.5">Manually select specific repositories to scan.</span>
                  </div>
                </label>
                
                {targetReposType === "selected" && (
                    <div className="ml-6 pl-3 border-l-2 border-gray-200 dark:border-rule mt-2 space-y-4">
                    <label className="flex items-center gap-2 cursor-pointer group/chk">
                      <input 
                        type="checkbox"
                        checked={includeFutureRepos}
                        onChange={(e) => setIncludeFutureRepos(e.target.checked)}
                        className="accent-ink w-4 h-4 cursor-pointer"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-gh-textBase dark:text-slate-200">Auto-include future repositories</span>
                        <span className="text-[11px] text-gh-muted dark:text-slate-400">Any repository created after this scanner will be automatically scanned.</span>
                      </div>
                    </label>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gh-muted dark:text-slate-400">Select Repositories</span>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setSelectedRepos(repos?.map((r: any) => r.name) || [])}
                            className="textlink caps"
                          >
                            Select All
                          </button>
                          <span className="text-gray-300 dark:text-slate-600">•</span>
                          <button 
                            type="button"
                            onClick={() => setSelectedRepos([])}
                            className="textlink caps"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-rule rounded-md bg-white dark:bg-paper shadow-sm ring-1 ring-inset ring-gray-300/50 dark:ring-rule">
                        {repos?.map((r: any) => (
                          <label key={r.name} className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 dark:border-rule last:border-b-0 hover:bg-gray-50 dark:hover:bg-paper-2 cursor-pointer transition-colors">
                            <input 
                              type="checkbox"
                              checked={selectedRepos.includes(r.name)}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRepos([...selectedRepos, r.name]);
                                } else {
                                  setSelectedRepos(selectedRepos.filter(name => name !== r.name));
                                }
                              }}
                              className="accent-ink w-4 h-4 cursor-pointer"
                            />
                            <span className="text-sm font-mono text-gh-textBase dark:text-slate-200">{r.name}</span>
                          </label>
                        ))}
                        {!repos?.length && (
                          <div className="p-3 text-sm text-gray-500 dark:text-slate-400 text-center italic">No repositories found</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <hr className="border-rule dark:border-rule" />

          <div>
            <div className="flex justify-between items-end mb-3">
              <label className="caps block">Compliance Conditions</label>
              <button 
                onClick={addCondition}
                className="textlink caps"
              >
                + Add Condition
              </button>
            </div>

            <div className="space-y-4">
              {conditions.map((cond, idx) => (
                <div key={idx} className="border border-rule dark:border-rule rounded-lg bg-gray-50/30 dark:bg-paper-2/30 p-4 relative">
                  <button 
                    onClick={() => removeCondition(idx)}
                    className="absolute top-3 right-3 text-gray-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400"
                  >
                    <i className="fa-solid fa-trash-can"></i>
                  </button>

                  <div className="mb-4 pr-6">
                    <label className="caps block mb-1">Condition Type</label>
                    <select 
                      value={cond.type || "branch_protection"}
                      onChange={(e) => updateCondition(idx, "type", e.target.value)}
                      className="field-line text-[13.5px] w-full"
                    >
                      <option value="branch_protection">Branch Protection Rule</option>
                      <option value="query">Security Insight Query</option>
                    </select>
                  </div>

                  {(!cond.type || cond.type === "branch_protection") && (
                    <div className="space-y-4">
                  <div>
                    <label className="caps block mb-1">Branch Patterns</label>
                    <TagInput
                      tags={cond.branchPatterns || []}
                      onChange={(tags) => updateCondition(idx, "branchPatterns", tags)}
                      placeholder="e.g. main (Press Enter)"
                      onPendingTextChange={(pending) => updateCondition(idx, "hasPendingBranch", pending)}
                      icon="ph-git-branch"
                      colorClass="blue"
                    />
                  </div>

                    <div className="flex items-center gap-2 mt-4 mb-4">
                      <div 
                        className={`w-10 h-5 flex items-center border border-rule-strong p-1 cursor-pointer transition-colors ${cond.requiresProtection ? "bg-ink" : "bg-paper-2"}`}
                        onClick={() => updateCondition(idx, "requiresProtection", !cond.requiresProtection)}
                      >
                        <div className={`w-3 h-3 transform transition-transform ${cond.requiresProtection ? "translate-x-5 bg-paper" : "bg-ink-3"}`}></div>
                      </div>
                      <span className="text-sm font-medium text-gh-textBase dark:text-slate-200">Check for protection rules</span>
                    </div>

                  {cond.requiresProtection && (
                    <div className="mt-3 border-t border-rule dark:border-rule pt-4">
                      <div className="mb-3">
                        <label className="caps block mb-1">Protection Type</label>
                        <select 
                          value={cond.protectionType || "any"}
                          onChange={(e) => updateCondition(idx, "protectionType", e.target.value)}
                          className="field-line text-[13.5px] w-full"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                          <option value="classic">Must use Classic Protection</option>
                        </select>
                      </div>

                      <div className="mb-3">
                        <label className="caps block mb-1">Rule Matching Mode</label>
                        <select 
                          value={cond.ruleMatchType || "at_least"}
                          onChange={(e) => updateCondition(idx, "ruleMatchType", e.target.value)}
                          className="field-line text-[13.5px] w-full"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>

                      {(!cond.ruleMatchType || cond.ruleMatchType !== "any") && (
                        <div className="bg-white dark:bg-paper border border-gray-200 dark:border-rule rounded p-3 text-sm">
                          <h4 className="caps mb-3">Required Rules</h4>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-4">
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.requirePr}
                            onChange={(e) => updateRule(idx, "requirePr", e.target.checked)}
                            className="field-line text-[13.5px]"
                          />
                          Require Pull Request
                        </label>

                        {cond.rules?.requirePr && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gh-muted dark:text-slate-400">Min. Approvals:</span>
                            <input 
                              type="number" 
                              min="1" max="5"
                              value={cond.rules.minApprovals || 1}
                              onChange={(e) => updateRule(idx, "minApprovals", parseInt(e.target.value))}
                              className="field-line text-[13.5px]"
                            />
                          </div>
                        )}
                        
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.dismissStaleReviews}
                            onChange={(e) => updateRule(idx, "dismissStaleReviews", e.target.checked)}
                            className="field-line text-[13.5px]"
                          />
                          Dismiss stale reviews
                        </label>
                        
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.preventForcePush}
                            onChange={(e) => updateRule(idx, "preventForcePush", e.target.checked)}
                            className="field-line text-[13.5px]"
                          />
                          Prevent force pushing
                        </label>

                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.preventDeletion}
                            onChange={(e) => updateRule(idx, "preventDeletion", e.target.checked)}
                            className="field-line text-[13.5px]"
                          />
                          Prevent deletion
                        </label>
                      </div>

                      <details className="group/details mt-3">
                        <summary className="text-xs font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1.5 select-none pt-2 border-t border-gray-100 dark:border-rule">
                          <i className="ph-bold ph-caret-right text-[10px] group-open/details:rotate-90 transition-transform"></i>
                          Advanced Rules
                        </summary>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-4 pt-3 mt-1">
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireCodeOwnerReviews}
                              onChange={(e) => updateRule(idx, "requireCodeOwnerReviews", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Require Code Owner review
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireConversationResolution}
                              onChange={(e) => updateRule(idx, "requireConversationResolution", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Require conversation resolution
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireStatusChecks}
                              onChange={(e) => updateRule(idx, "requireStatusChecks", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Require status checks
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.strictStatusChecks}
                              onChange={(e) => updateRule(idx, "strictStatusChecks", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Strict status checks (require up to date)
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireSignedCommits}
                              onChange={(e) => updateRule(idx, "requireSignedCommits", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Require signed commits
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireLinearHistory}
                              onChange={(e) => updateRule(idx, "requireLinearHistory", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Require linear history
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.enforceAdmins}
                              onChange={(e) => updateRule(idx, "enforceAdmins", e.target.checked)}
                              className="field-line text-[13.5px]"
                            />
                            Enforce for admins
                          </label>
                        </div>
                      </details>
                    </div>
                  )}
                  </div>
                )}

                {cond.type === ("query" as any) && (
                  <div className="space-y-4 pt-2">
                    <div>
                      <label className="caps block mb-1">Select Insight Query</label>
                      <select 
                        value={cond.queryId || ""}
                        onChange={(e) => {
                          const qid = e.target.value;
                          const qopt = QUERY_OPTIONS.find(q => q.id === qid);
                          updateCondition(idx, "queryId", qid);
                          if (qopt?.requiresParam && qopt.paramDefault) {
                            updateCondition(idx, "queryParam", qopt.paramDefault);
                          } else {
                            updateCondition(idx, "queryParam", "");
                          }
                          if (qopt?.hasAdvancedRules) {
                            updateCondition(idx, "queryAdvanced", { protectionType: "any", requirePr: false, requireStatusChecks: false, enforceAdmins: false });
                          } else {
                            updateCondition(idx, "queryAdvanced", undefined);
                          }
                        }}
                        className="field-line text-[13.5px] w-full"
                      >
                        <option value="" disabled>Select a query...</option>
                        {QUERY_OPTIONS.map(q => (
                          <option key={q.id} value={q.id}>{q.label}</option>
                        ))}
                      </select>
                    </div>

                    {cond.queryId && (() => {
                      const selectedQuery = QUERY_OPTIONS.find(q => q.id === cond.queryId);
                      return (
                        <>
                          {selectedQuery?.requiresParam && (
                            <div>
                              <label className="caps block mb-1">{selectedQuery.paramLabel}</label>
                              {selectedQuery.useTagInput ? (
                                <TagInput
                                  tags={cond.queryParam ? cond.queryParam.split(",").map(s => s.trim()).filter(Boolean) : []}
                                  onChange={(tags) => updateCondition(idx, "queryParam", tags.join(", "))}
                                  placeholder={`Enter ${paramNoun(selectedQuery.paramLabel)} and press Enter`}
                                  onPendingTextChange={(pending) => updateCondition(idx, "hasPendingQuery", pending)}
                                  icon={selectedQuery.paramIcon ?? selectedQuery.icon}
                                  colorClass="blue"
                                />
                              ) : (
                                <input 
                                  type="text"
                                  value={cond.queryParam || ""}
                                  onChange={(e) => updateCondition(idx, "queryParam", e.target.value)}
                                  placeholder={`Enter ${paramNoun(selectedQuery.paramLabel)}...`}
                                  className="field-line text-[13.5px] w-full"
                                />
                              )}
                            </div>
                          )}

                          {selectedQuery?.hasAdvancedRules && (
                            <div className="bg-white dark:bg-paper border border-gray-200 dark:border-rule rounded p-3 text-sm mt-3">
                              <h4 className="caps mb-3">Advanced Rules</h4>
                              <div className="mb-3">
                                <label className="caps block mb-1">Protection Type</label>
                                <select 
                                  value={cond.queryAdvanced?.protectionType || "any"}
                                  onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, protectionType: e.target.value })}
                                  className="field-line text-[13.5px] w-full"
                                >
                                  <option value="any">Any protection</option>
                                  <option value="classic">Classic only</option>
                                  <option value="ruleset">Ruleset only</option>
                                </select>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4">
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requirePr}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requirePr: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Require PRs
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requireStatusChecks}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requireStatusChecks: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Require Status Checks
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.enforceAdmins}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, enforceAdmins: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Enforce Admins
                                </label>
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                    </div>
                  )}
                    </div>
                  )}

                {cond.type === ("query" as any) && (
                  <div className="space-y-4 pt-2">
                    <div>
                      <label className="caps block mb-1">Select Insight Query</label>
                      <select 
                        value={cond.queryId || ""}
                        onChange={(e) => {
                          const qid = e.target.value;
                          const qopt = QUERY_OPTIONS.find(q => q.id === qid);
                          updateCondition(idx, "queryId", qid);
                          if (qopt?.requiresParam && qopt.paramDefault) {
                            updateCondition(idx, "queryParam", qopt.paramDefault);
                          } else {
                            updateCondition(idx, "queryParam", "");
                          }
                          if (qopt?.hasAdvancedRules) {
                            updateCondition(idx, "queryAdvanced", { protectionType: "any", requirePr: false, requireStatusChecks: false, enforceAdmins: false });
                          } else {
                            updateCondition(idx, "queryAdvanced", undefined);
                          }
                        }}
                        className="field-line text-[13.5px] w-full"
                      >
                        <option value="" disabled>Select a query...</option>
                        {QUERY_OPTIONS.map(q => (
                          <option key={q.id} value={q.id}>{q.label}</option>
                        ))}
                      </select>
                    </div>

                    {cond.queryId && (() => {
                      const selectedQuery = QUERY_OPTIONS.find(q => q.id === cond.queryId);
                      return (
                        <>
                          {selectedQuery?.requiresParam && (
                            <div>
                              <label className="caps block mb-1">{selectedQuery.paramLabel}</label>
                              {selectedQuery.useTagInput ? (
                                <TagInput
                                  tags={cond.queryParam ? cond.queryParam.split(",").map(s => s.trim()).filter(Boolean) : []}
                                  onChange={(tags) => updateCondition(idx, "queryParam", tags.join(", "))}
                                  placeholder={`Enter ${paramNoun(selectedQuery.paramLabel)} and press Enter`}
                                  onPendingTextChange={(pending) => updateCondition(idx, "hasPendingQuery", pending)}
                                  icon={selectedQuery.paramIcon ?? selectedQuery.icon}
                                  colorClass="blue"
                                />
                              ) : (
                                <input 
                                  type="text"
                                  value={cond.queryParam || ""}
                                  onChange={(e) => updateCondition(idx, "queryParam", e.target.value)}
                                  placeholder={`Enter ${paramNoun(selectedQuery.paramLabel)}...`}
                                  className="field-line text-[13.5px] w-full"
                                />
                              )}
                            </div>
                          )}

                          {selectedQuery?.hasAdvancedRules && (
                            <div className="bg-white dark:bg-paper border border-gray-200 dark:border-rule rounded p-3 text-sm mt-3">
                              <h4 className="caps mb-3">Advanced Rules</h4>
                              <div className="mb-3">
                                <label className="caps block mb-1">Protection Type</label>
                                <select 
                                  value={cond.queryAdvanced?.protectionType || "any"}
                                  onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, protectionType: e.target.value })}
                                  className="field-line text-[13.5px] w-full"
                                >
                                  <option value="any">Any protection</option>
                                  <option value="classic">Classic only</option>
                                  <option value="ruleset">Ruleset only</option>
                                </select>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-2 gap-x-4">
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requirePr}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requirePr: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Require PRs
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requireStatusChecks}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requireStatusChecks: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Require Status Checks
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.enforceAdmins}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, enforceAdmins: e.target.checked })}
                                    className="field-line text-[13.5px]"
                                  /> Enforce Admins
                                </label>
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                </div>
              ))}
              {conditions.length === 0 && (
                <div className="text-sm text-gh-muted dark:text-slate-400 italic py-2">No conditions defined. Scanner will flag nothing.</div>
              )}
            </div>
            {errorMsg && (
              <div className="mt-4 p-3 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm rounded-md flex items-start gap-2 animate-fade-in">
                <i className="fa-solid fa-circle-exclamation mt-0.5"></i>
                <span>{errorMsg}</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-rule dark:border-rule bg-gray-50/50 dark:bg-paper-2/50 flex justify-end gap-3 rounded-b-[12px] shrink-0">
          <button 
            onClick={onClose}
            className="stamp stamp-hollow"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={!name || createMutation.isPending || updateMutation.isPending || conditions.some(c => (c as any).hasPendingBranch || (c as any).hasPendingQuery)}
            className="stamp"
          >
            {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save Scanner"}
          </button>
        </div>
      </div>
    </div>
  );
}
