import { useState, useEffect } from "react";
import { useCreateScanner, useUpdateScanner } from "../hooks/useScanners";
import { useRepos } from "../hooks/useRepos";
import type { ScannerCondition } from "../types/Scanner";
import { QUERY_OPTIONS } from "../utils/queryOptions";

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
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-[12px] shadow-modal border border-black/10 w-full max-w-3xl relative z-10 animate-slide-up flex flex-col max-h-[90vh]">
        
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white pt-5 shrink-0 rounded-t-[12px]">
          <h3 className="text-lg font-bold text-gray-900 tracking-tight">
            {scanner ? "Edit Scanner" : "Create Compliance Scanner"}
          </h3>
          <button 
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-black/5 transition-colors"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gh-textBase mb-1">Scanner Name</label>
              <input 
                type="text" 
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. SOC2 Branch Compliance" 
                className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset ring-gray-300 outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gh-textBase mb-1">Description</label>
              <input 
                type="text" 
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this verify?" 
                className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue focus:ring focus:ring-gh-blue/30 sm:text-sm py-2 px-3 text-gh-textBase ring-1 ring-inset ring-gray-300 outline-none"
              />
            </div>
            <div className="border border-gh-border rounded-lg p-4 bg-gray-50/30">
              <label className="block text-sm font-semibold text-gh-textBase mb-3">Target Repositories</label>
              
              <div className="space-y-4">
                <label className="flex items-start gap-2 cursor-pointer group/radio">
                  <input 
                    type="radio" 
                    name="targetType"
                    checked={targetReposType === "all"}
                    onChange={() => setTargetReposType("all")}
                    className="mt-0.5 w-4 h-4 text-gh-blue border-gray-300 focus:ring-gh-blue"
                  />
                  <div>
                    <span className="block text-sm font-medium text-gh-textBase">All repositories (auto-include future repos)</span>
                    <span className="block text-[11px] text-gh-muted mt-0.5">Scan all current and future repositories in the organization automatically.</span>
                  </div>
                </label>
                
                <label className="flex items-start gap-2 cursor-pointer group/radio">
                  <input 
                    type="radio" 
                    name="targetType"
                    checked={targetReposType === "selected"}
                    onChange={() => setTargetReposType("selected")}
                    className="mt-0.5 w-4 h-4 text-gh-blue border-gray-300 focus:ring-gh-blue"
                  />
                  <div>
                    <span className="block text-sm font-medium text-gh-textBase">Selected repositories</span>
                    <span className="block text-[11px] text-gh-muted mt-0.5">Manually select specific repositories to scan.</span>
                  </div>
                </label>
                
                {targetReposType === "selected" && (
                  <div className="ml-6 pl-3 border-l-2 border-gray-200 mt-2 space-y-4">
                    <label className="flex items-center gap-2 cursor-pointer group/chk">
                      <input 
                        type="checkbox"
                        checked={includeFutureRepos}
                        onChange={(e) => setIncludeFutureRepos(e.target.checked)}
                        className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue"
                      />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium text-gh-textBase">Auto-include future repositories</span>
                        <span className="text-[11px] text-gh-muted">Any repository created after this scanner will be automatically scanned.</span>
                      </div>
                    </label>

                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gh-muted">Select Repositories</span>
                        <div className="flex gap-2">
                          <button 
                            type="button"
                            onClick={() => setSelectedRepos(repos?.map((r: any) => r.name) || [])}
                            className="text-xs font-medium text-gh-blue hover:text-gh-blueHover"
                          >
                            Select All
                          </button>
                          <span className="text-gray-300">•</span>
                          <button 
                            type="button"
                            onClick={() => setSelectedRepos([])}
                            className="text-xs font-medium text-gh-muted hover:text-gray-700"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-md bg-white shadow-sm ring-1 ring-inset ring-gray-300/50">
                        {repos?.map((r: any) => (
                          <label key={r.name} className="flex items-center gap-2.5 px-3 py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-50 cursor-pointer transition-colors">
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
                              className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue focus:ring-offset-1 transition-all"
                            />
                            <span className="text-sm font-mono text-gh-textBase">{r.name}</span>
                          </label>
                        ))}
                        {!repos?.length && (
                          <div className="p-3 text-sm text-gray-500 text-center italic">No repositories found</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <hr className="border-gh-border" />

          <div>
            <div className="flex justify-between items-end mb-3">
              <label className="block text-sm font-bold text-gh-textBase">Compliance Conditions</label>
              <button 
                onClick={addCondition}
                className="text-xs font-semibold text-gh-blue hover:text-gh-blueHover"
              >
                + Add Condition
              </button>
            </div>

            <div className="space-y-4">
              {conditions.map((cond, idx) => (
                <div key={idx} className="border border-gh-border rounded-lg bg-gray-50/30 p-4 relative">
                  <button 
                    onClick={() => removeCondition(idx)}
                    className="absolute top-3 right-3 text-gray-400 hover:text-red-500"
                  >
                    <i className="fa-solid fa-trash-can"></i>
                  </button>

                  <div className="mb-4 pr-6">
                    <label className="block text-xs font-semibold text-gh-textBase mb-1">Condition Type</label>
                    <select 
                      value={cond.type || "branch_protection"}
                      onChange={(e) => updateCondition(idx, "type", e.target.value)}
                      className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
                    >
                      <option value="branch_protection">Branch Protection Rule</option>
                      <option value="query">Security Insight Query</option>
                    </select>
                  </div>

                  {(!cond.type || cond.type === "branch_protection") && (
                    <div>
                  <div className="mb-4 pr-6">
                    <label className="block text-xs font-semibold text-gh-textBase mb-1">Branch Patterns</label>
                    <div className="flex flex-wrap gap-2 p-1.5 min-h-[36px] bg-white border border-gray-300 rounded-md shadow-sm focus-within:ring-1 focus-within:ring-gh-blue focus-within:border-gh-blue cursor-text"
                         onClick={(e) => {
                           const target = e.target as HTMLElement;
                           if (target === e.currentTarget) {
                             const input = target.querySelector('input');
                             if (input) input.focus();
                           }
                         }}>
                        {cond.branchPatterns?.map((pattern, pIdx) => (
                          <span key={pIdx} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[13px] font-mono bg-white text-gh-textBase border border-gray-200 shadow-sm">
                            {pattern}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                const newPatterns = cond.branchPatterns?.filter((_, i) => i !== pIdx) || [];
                                updateCondition(idx, "branchPatterns", newPatterns);
                              }}
                              className="text-gray-400 hover:text-gray-600 focus:outline-none"
                            >
                              <i className="ph-bold ph-x text-[10px]"></i>
                            </button>
                          </span>
                        ))}
                        <input 
                          type="text" 
                          value={cond.inputVal || ''}
                          onChange={(e) => updateCondition(idx, "inputVal", e.target.value)}
                          placeholder={!cond.branchPatterns || cond.branchPatterns.length === 0 ? "e.g. main (Press Enter)" : ""} 
                          className="flex-1 min-w-[120px] outline-none border-none shadow-none focus:ring-0 p-0 text-sm font-mono text-gh-textBase bg-transparent"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const val = e.currentTarget.value.trim();
                              const patterns = cond.branchPatterns || [];
                              if (val && !patterns.includes(val)) {
                                updateCondition(idx, "branchPatterns", [...patterns, val]);
                                updateCondition(idx, "inputVal", "");
                              }
                            } else if (e.key === 'Backspace' && e.currentTarget.value === '' && (cond.branchPatterns?.length || 0) > 0) {
                              const newPatterns = [...(cond.branchPatterns || [])];
                              newPatterns.pop();
                              updateCondition(idx, "branchPatterns", newPatterns);
                            }
                          }}
                        />
                      </div>
                      <p className="text-[11px] text-gh-muted mt-1">Press <kbd className="px-1 py-0.5 rounded bg-gray-100 border border-gray-200 text-[10px]">Enter</kbd> to add a branch pattern</p>
                  </div>

                    <div className="flex items-center gap-2 mt-4 mb-4">
                      <div 
                        className={`w-10 h-5 flex items-center rounded-full p-1 cursor-pointer transition-colors ${cond.requiresProtection ? 'bg-gh-blue' : 'bg-gray-300'}`}
                        onClick={() => updateCondition(idx, "requiresProtection", !cond.requiresProtection)}
                      >
                        <div className={`bg-white w-3 h-3 rounded-full shadow-md transform transition-transform ${cond.requiresProtection ? 'translate-x-5' : ''}`}></div>
                      </div>
                      <span className="text-sm font-medium text-gh-textBase">Check for protection rules</span>
                    </div>

                  {cond.requiresProtection && (
                    <div className="mt-3 border-t border-gh-border pt-4">
                      <div className="mb-3">
                        <label className="block text-xs font-semibold text-gh-textBase mb-1">Protection Type</label>
                        <select 
                          value={cond.protectionType || "any"}
                          onChange={(e) => updateCondition(idx, "protectionType", e.target.value)}
                          className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
                        >
                          <option value="any">Must have ANY protection</option>
                          <option value="ruleset">Must use Repository Ruleset</option>
                          <option value="classic">Must use Classic Protection</option>
                        </select>
                      </div>

                      <div className="mb-3">
                        <label className="block text-xs font-semibold text-gh-textBase mb-1">Rule Matching Mode</label>
                        <select 
                          value={cond.ruleMatchType || "at_least"}
                          onChange={(e) => updateCondition(idx, "ruleMatchType", e.target.value)}
                          className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
                        >
                          <option value="any">Any rules (just check if protection exists)</option>
                          <option value="at_least">Must have at least the selected rules</option>
                          <option value="exact">Must match exactly the selected rules</option>
                        </select>
                      </div>

                      {(!cond.ruleMatchType || cond.ruleMatchType !== "any") && (
                        <div className="bg-white border border-gray-200 rounded p-3 text-sm">
                          <h4 className="font-semibold text-xs text-gh-muted uppercase tracking-wider mb-3">Required Rules</h4>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-4">
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.requirePr}
                            onChange={(e) => updateRule(idx, "requirePr", e.target.checked)}
                            className="rounded text-gh-blue focus:ring-gh-blue"
                          />
                          Require Pull Request
                        </label>

                        {cond.rules?.requirePr && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gh-muted">Min. Approvals:</span>
                            <input 
                              type="number" 
                              min="1" max="5"
                              value={cond.rules.minApprovals || 1}
                              onChange={(e) => updateRule(idx, "minApprovals", parseInt(e.target.value))}
                              className="w-16 rounded-md border-gray-300 py-1 px-2 text-xs ring-1 ring-inset ring-gray-300 outline-none focus:border-gh-blue"
                            />
                          </div>
                        )}
                        
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.dismissStaleReviews}
                            onChange={(e) => updateRule(idx, "dismissStaleReviews", e.target.checked)}
                            className="rounded text-gh-blue focus:ring-gh-blue"
                          />
                          Dismiss stale reviews
                        </label>
                        
                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.preventForcePush}
                            onChange={(e) => updateRule(idx, "preventForcePush", e.target.checked)}
                            className="rounded text-gh-blue focus:ring-gh-blue"
                          />
                          Prevent force pushing
                        </label>

                        <label className="flex items-center gap-2">
                          <input 
                            type="checkbox" 
                            checked={!!cond.rules?.preventDeletion}
                            onChange={(e) => updateRule(idx, "preventDeletion", e.target.checked)}
                            className="rounded text-gh-blue focus:ring-gh-blue"
                          />
                          Prevent deletion
                        </label>
                      </div>

                      <details className="group/details mt-3">
                        <summary className="text-xs font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1.5 select-none pt-2 border-t border-gray-100">
                          <i className="ph-bold ph-caret-right text-[10px] group-open/details:rotate-90 transition-transform"></i>
                          Advanced Rules
                        </summary>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-4 pt-3 mt-1">
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireCodeOwnerReviews}
                              onChange={(e) => updateRule(idx, "requireCodeOwnerReviews", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Require Code Owner review
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireConversationResolution}
                              onChange={(e) => updateRule(idx, "requireConversationResolution", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Require conversation resolution
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireStatusChecks}
                              onChange={(e) => updateRule(idx, "requireStatusChecks", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Require status checks
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.strictStatusChecks}
                              onChange={(e) => updateRule(idx, "strictStatusChecks", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Strict status checks (require up to date)
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireSignedCommits}
                              onChange={(e) => updateRule(idx, "requireSignedCommits", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Require signed commits
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.requireLinearHistory}
                              onChange={(e) => updateRule(idx, "requireLinearHistory", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
                            />
                            Require linear history
                          </label>
                          <label className="flex items-center gap-2">
                            <input 
                              type="checkbox" 
                              checked={!!cond.rules?.enforceAdmins}
                              onChange={(e) => updateRule(idx, "enforceAdmins", e.target.checked)}
                              className="rounded text-gh-blue focus:ring-gh-blue"
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
                      <label className="block text-xs font-semibold text-gh-textBase mb-1">Select Insight Query</label>
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
                        className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
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
                              <label className="block text-xs font-semibold text-gh-textBase mb-1">{selectedQuery.paramLabel}</label>
                              <input 
                                type="text"
                                value={cond.queryParam || ""}
                                onChange={(e) => updateCondition(idx, "queryParam", e.target.value)}
                                placeholder={`Enter ${selectedQuery.paramLabel?.toLowerCase() || 'value'}...`}
                                className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
                              />
                            </div>
                          )}

                          {selectedQuery?.hasAdvancedRules && (
                            <div className="bg-white border border-gray-200 rounded p-3 text-sm mt-3">
                              <h4 className="font-semibold text-xs text-gh-muted uppercase tracking-wider mb-3">Advanced Rules</h4>
                              <div className="mb-3">
                                <label className="block text-xs font-semibold text-gh-textBase mb-1">Protection Type</label>
                                <select 
                                  value={cond.queryAdvanced?.protectionType || "any"}
                                  onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, protectionType: e.target.value })}
                                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
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
                                    className="rounded text-gh-blue focus:ring-gh-blue"
                                  /> Require PRs
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requireStatusChecks}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requireStatusChecks: e.target.checked })}
                                    className="rounded text-gh-blue focus:ring-gh-blue"
                                  /> Require Status Checks
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.enforceAdmins}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, enforceAdmins: e.target.checked })}
                                    className="rounded text-gh-blue focus:ring-gh-blue"
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
                      <label className="block text-xs font-semibold text-gh-textBase mb-1">Select Insight Query</label>
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
                        className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
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
                              <label className="block text-xs font-semibold text-gh-textBase mb-1">{selectedQuery.paramLabel}</label>
                              <input 
                                type="text"
                                value={cond.queryParam || ""}
                                onChange={(e) => updateCondition(idx, "queryParam", e.target.value)}
                                placeholder={`Enter ${selectedQuery.paramLabel?.toLowerCase() || 'value'}...`}
                                className="block w-full rounded-md border-gh-border shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
                              />
                            </div>
                          )}

                          {selectedQuery?.hasAdvancedRules && (
                            <div className="bg-white border border-gray-200 rounded p-3 text-sm mt-3">
                              <h4 className="font-semibold text-xs text-gh-muted uppercase tracking-wider mb-3">Advanced Rules</h4>
                              <div className="mb-3">
                                <label className="block text-xs font-semibold text-gh-textBase mb-1">Protection Type</label>
                                <select 
                                  value={cond.queryAdvanced?.protectionType || "any"}
                                  onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, protectionType: e.target.value })}
                                  className="block w-full rounded-md border-gray-300 shadow-sm focus:border-gh-blue sm:text-sm py-1.5 px-3 ring-1 ring-inset ring-gray-300 outline-none"
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
                                    className="rounded text-gh-blue focus:ring-gh-blue"
                                  /> Require PRs
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.requireStatusChecks}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, requireStatusChecks: e.target.checked })}
                                    className="rounded text-gh-blue focus:ring-gh-blue"
                                  /> Require Status Checks
                                </label>
                                <label className="flex items-center gap-2">
                                  <input 
                                    type="checkbox" 
                                    checked={!!cond.queryAdvanced?.enforceAdmins}
                                    onChange={(e) => updateCondition(idx, "queryAdvanced", { ...cond.queryAdvanced, enforceAdmins: e.target.checked })}
                                    className="rounded text-gh-blue focus:ring-gh-blue"
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
                <div className="text-sm text-gh-muted italic py-2">No conditions defined. Scanner will flag nothing.</div>
              )}
            </div>
            {errorMsg && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md flex items-start gap-2 animate-fade-in">
                <i className="fa-solid fa-circle-exclamation mt-0.5"></i>
                <span>{errorMsg}</span>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-gh-border bg-gray-50/50 flex justify-end gap-3 rounded-b-[12px] shrink-0">
          <button 
            onClick={onClose}
            className="px-4 py-2 border border-gh-border shadow-sm text-sm font-medium rounded-md text-gh-textBase bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-200"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave}
            disabled={!name || createMutation.isPending || updateMutation.isPending}
            className="px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-gh-blue hover:bg-gh-blueHover focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gh-blue/50 disabled:opacity-50"
          >
            {createMutation.isPending || updateMutation.isPending ? "Saving..." : "Save Scanner"}
          </button>
        </div>
      </div>
    </div>
  );
}
