import { useState, useEffect } from "react";
import type { TagRule } from "../types/Template";
import { Toggle, Section, BypassActorsSection } from "./RulesetShared";
import type { BypassActor } from "./RulesetShared";

export const DEFAULT_TAG_PROTECTION: TagRule = {
  tagPatterns: [],
  rulesetName: "",
  enforcement: "active",
  preventCreation: false,
  preventUpdate: false,
  preventDeletion: true,
  preventForcePush: true,
  requireSignedCommits: false,
  bypassActors: [],
};

export function parseGitHubTagRulesetJson(json: any): TagRule {
  const result: TagRule = { ...DEFAULT_TAG_PROTECTION };

  if (Array.isArray(json)) {
    parseRules(json, result);
    return result;
  }

  if (json.name) result.rulesetName = json.name;
  if (json.enforcement) result.enforcement = json.enforcement as TagRule["enforcement"];

  if (json.bypass_actors && json.bypass_actors.length > 0) {
    result.bypassActors = json.bypass_actors.map((a: any) => ({
      actor_id: a.actor_id,
      actor_type: a.actor_type,
      bypass_mode: a.bypass_mode || "always",
    }));
  }

  if (json.conditions?.ref_name?.include) {
    result.tagPatterns = json.conditions.ref_name.include.map((r: string) =>
      r.startsWith("refs/tags/") ? r.slice("refs/tags/".length) : r
    );
  }

  parseRules(json.rules || [], result);
  return result;
}

function parseRules(rules: any[], result: TagRule) {
  result.preventCreation = false;
  result.preventUpdate = false;
  result.preventDeletion = false;
  result.preventForcePush = false;
  result.requireSignedCommits = false;
  result.namePattern = undefined;

  for (const rule of rules) {
    switch (rule.type) {
      case "creation":
        result.preventCreation = true;
        break;
      case "update":
        result.preventUpdate = true;
        break;
      case "deletion":
        result.preventDeletion = true;
        break;
      case "non_fast_forward":
        result.preventForcePush = true;
        break;
      case "required_signatures":
        result.requireSignedCommits = true;
        break;
      case "tag_name_pattern": {
        const p = rule.parameters || {};
        result.namePattern = {
          operator: p.operator || "starts_with",
          pattern: p.pattern || "",
          negate: p.negate ?? false,
          name: p.name,
        };
        break;
      }
    }
  }
}

interface ProtectTagModalProps {
  isOpen: boolean;
  onClose: () => void;
  tagPatterns: string[];
  initialData?: TagRule;
  onSave: (rule: TagRule) => void;
  isSaving: boolean;
  isTemplateMode?: boolean;
}

export default function ProtectTagModal({
  isOpen,
  onClose,
  tagPatterns,
  initialData,
  onSave,
  isSaving,
  isTemplateMode = false,
}: ProtectTagModalProps) {
  const [rule, setRule] = useState<TagRule>({ ...DEFAULT_TAG_PROTECTION });
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [enforceAdmins, setEnforceAdmins] = useState(true);

  useEffect(() => {
    if (isOpen) {
      if (initialData?.rawJson) {
        setRule(initialData);
        setMode("json");
        setJsonText(JSON.stringify(initialData.rawJson, null, 2));
      } else {
        setRule(initialData || { ...DEFAULT_TAG_PROTECTION });
        setMode("form");
        setJsonText("");
      }
      const bypass = initialData?.bypassActors || [];
      setEnforceAdmins(bypass.length === 0);
      setJsonError("");
    }
  }, [isOpen, initialData]);

  const update = (field: string, val: any) => {
    setRule(prev => ({ ...prev, [field]: val }));
  };

  const handleApplyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed.rules || !Array.isArray(parsed.rules)) {
        setJsonError("Invalid format: expected a GitHub ruleset JSON with a \"rules\" array.");
        return;
      }
      if (isTemplateMode) {
        const { rawJson: _r, ...base } = rule;
        onSave({ ...base, rawJson: parsed, rulesetName: parsed.name || rule.rulesetName } as TagRule);
      } else {
        const imported = parseGitHubTagRulesetJson(parsed);
        onSave(imported);
      }
    } catch {
      setJsonError("Invalid JSON. Please paste a valid GitHub tag ruleset JSON.");
    }
  };

  if (!isOpen) return null;

  const ruleCount = [rule.preventCreation, rule.preventUpdate, rule.preventDeletion, rule.preventForcePush, rule.requireSignedCommits, !!rule.namePattern?.pattern].filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-[12px] shadow-modal border border-black/10 dark:border-slate-700 w-full max-w-[680px] relative z-10 animate-slide-up overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gh-border dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-900 pt-5 shrink-0">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white tracking-tight flex items-center gap-2">
            <i className="ph-bold ph-tag text-gh-blue"></i>
            Tag Ruleset Configuration
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 dark:text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors absolute right-4 top-4"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {tagPatterns.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-gh-muted dark:text-slate-400 font-medium self-center mr-1">Patterns:</span>
              {tagPatterns.map(p => (
                <span key={p} className="inline-flex items-center gap-1 text-xs bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 px-2 py-0.5 rounded-md font-mono">
                  <i className="ph-bold ph-tag text-[10px] text-amber-400 dark:text-amber-500"></i>
                  {p}
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 bg-gray-50 dark:bg-slate-800 p-1 rounded-md border border-gray-200 dark:border-slate-700 w-fit">
            <button
              type="button"
              onClick={() => setMode("form")}
              className={"px-3 py-1.5 text-xs font-semibold rounded-md transition-colors " + (
                mode === "form"
                  ? "bg-white dark:bg-slate-700 shadow-sm text-gh-textBase dark:text-slate-200 border border-gray-200/50 dark:border-slate-600"
                  : "text-gh-muted dark:text-slate-400 hover:text-gh-textBase dark:hover:text-slate-200 border border-transparent"
              )}
            >
              <i className="ph-bold ph-sliders-horizontal mr-1.5"></i>Form Builder
            </button>
            <button
              type="button"
              onClick={() => setMode("json")}
              className={"px-3 py-1.5 text-xs font-semibold rounded-md transition-colors " + (
                mode === "json"
                  ? "bg-white dark:bg-slate-700 shadow-sm text-gh-textBase dark:text-slate-200 border border-gray-200/50 dark:border-slate-600"
                  : "text-gh-muted dark:text-slate-400 hover:text-gh-textBase dark:hover:text-slate-200 border border-transparent"
              )}
            >
              <i className="ph-bold ph-code mr-1.5"></i>Direct JSON
            </button>
          </div>

          {mode === "json" ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gh-muted dark:text-slate-400 mb-3">
                  Paste a GitHub tag ruleset JSON below. The tag patterns from the JSON's <code className="text-xs bg-gray-100 dark:bg-slate-700 px-1 rounded font-mono">conditions</code> will be used.
                </p>
                <textarea
                  value={jsonText}
                  onChange={e => { setJsonText(e.target.value); setJsonError(""); }}
                  placeholder='Paste the full tag ruleset JSON here...'
                  rows={14}
                  className="w-full px-4 py-3 text-xs font-mono border border-gray-300 dark:border-slate-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue bg-gray-50 dark:bg-slate-800 dark:text-slate-200 resize-y"
                />
              </div>
              {jsonError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-800 rounded-lg">
                  <i className="ph-fill ph-warning-circle text-red-500"></i>
                  <span className="text-sm text-red-700 dark:text-red-400">{jsonError}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-4 border-b border-gray-100 dark:border-slate-700 pb-4">
                <div>
                  <label className="text-xs font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider block mb-1.5">Ruleset Name</label>
                  <input
                    type="text"
                    value={rule.rulesetName || ""}
                    onChange={e => update("rulesetName", e.target.value)}
                    placeholder="Tag Protection Ruleset"
                    className="w-full px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider block mb-1.5">Enforcement Status</label>
                  <select
                    value={rule.enforcement || "active"}
                    onChange={e => update("enforcement", e.target.value)}
                    className="w-full px-2 py-1.5 text-sm border-gray-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 ring-1 ring-inset ring-gray-200 dark:ring-slate-600 focus:outline-none focus:ring-gh-blue dark:text-slate-200"
                  >
                    <option value="active">Active</option>
                    <option value="evaluate">Evaluate (dry-run)</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </div>
              </div>

              <div className="space-y-3">
                <h4 className="text-xs font-bold text-gh-muted dark:text-slate-400 uppercase tracking-wider">Tag Rules</h4>

                <Section title="Restrict Operations" icon="ph-fill ph-lock-key" defaultOpen={!!(rule.preventCreation || rule.preventUpdate || rule.preventDeletion || rule.preventForcePush)}>
                  <div className="space-y-3">
                    <Toggle checked={!!rule.preventCreation} onChange={v => update("preventCreation", v)} label="Restrict tag creation" desc="Only allow users with bypass permission to create matching tags." />
                    <Toggle checked={!!rule.preventUpdate} onChange={v => update("preventUpdate", v)} label="Restrict tag updates" desc="Only allow users with bypass permission to update matching tags." />
                    <Toggle checked={!!rule.preventDeletion} onChange={v => update("preventDeletion", v)} label="Prevent tag deletion" desc="Tags matching this pattern cannot be deleted." />
                    <Toggle checked={!!rule.preventForcePush} onChange={v => update("preventForcePush", v)} label="Block force pushes" desc="Prevent non-fast-forward updates to matching tags." />
                  </div>
                </Section>

                <Section title="Commit Requirements" icon="ph-fill ph-git-commit" defaultOpen={!!rule.requireSignedCommits}>
                  <Toggle checked={!!rule.requireSignedCommits} onChange={v => update("requireSignedCommits", v)} label="Require signed commits" desc="Tags must point to commits with verified signatures." />
                </Section>

                <Section title="Tag Name Pattern" icon="ph-fill ph-textbox" defaultOpen={!!rule.namePattern?.pattern}>
                  <p className="text-[12px] text-gh-muted dark:text-slate-400 mb-3">
                    Optionally enforce a naming convention for tags matching these patterns.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-semibold text-gh-muted dark:text-slate-400 block mb-1.5">Operator</label>
                      <select
                        value={rule.namePattern?.operator || "starts_with"}
                        onChange={e => update("namePattern", { ...(rule.namePattern || { pattern: "", operator: "starts_with" }), operator: e.target.value })}
                        className="w-full px-2 py-1.5 text-sm border-gray-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-800 ring-1 ring-inset ring-gray-200 dark:ring-slate-600 focus:outline-none focus:ring-gh-blue dark:text-slate-200"
                      >
                        <option value="starts_with">Starts with</option>
                        <option value="ends_with">Ends with</option>
                        <option value="contains">Contains</option>
                        <option value="regex">Regex</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-semibold text-gh-muted dark:text-slate-400 block mb-1.5">Pattern</label>
                      <input
                        type="text"
                        value={rule.namePattern?.pattern || ""}
                        onChange={e => update("namePattern", { ...(rule.namePattern || { operator: "starts_with", pattern: "" }), pattern: e.target.value })}
                        placeholder="v"
                        className="w-full px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <Toggle
                      checked={rule.namePattern?.negate || false}
                      onChange={v => update("namePattern", { ...(rule.namePattern || { operator: "starts_with", pattern: "" }), negate: v })}
                      label="Negate pattern"
                      desc="Block tags that match this pattern instead of requiring them to match."
                    />
                  </div>
                  {!rule.namePattern?.pattern && (
                    <p className="text-[11px] text-gh-muted dark:text-slate-400 mt-2">Leave pattern blank to skip this rule.</p>
                  )}
                </Section>

                <BypassActorsSection
                  enforceAdmins={enforceAdmins}
                  onEnforceAdminsChange={v => {
                    setEnforceAdmins(v);
                    if (v) update("bypassActors", []);
                  }}
                  bypassActors={(rule.bypassActors || []) as BypassActor[]}
                  onBypassActorsChange={v => update("bypassActors", v)}
                  hideBypassMode={true}
                  requireWritePermission={true}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gh-border dark:border-slate-700 bg-gray-50/50 dark:bg-slate-800/50 flex items-center justify-between rounded-b-[12px] shrink-0">
          <div className="text-[11px] text-gh-muted dark:text-slate-400">
            {mode === "form" && ruleCount > 0 && (
              <span>{ruleCount} rule{ruleCount !== 1 ? "s" : ""} configured</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-[13px] font-semibold text-gh-textBase dark:text-slate-200 bg-white dark:bg-slate-800 border border-gh-border dark:border-slate-700 hover:bg-gray-50 dark:hover:bg-slate-700 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200 dark:focus:ring-slate-600"
            >
              Cancel
            </button>
            {mode === "form" ? (
              <button
                onClick={() => {
                  const { rawJson: _r, ...formRule } = rule;
                  onSave({ ...formRule } as TagRule);
                }}
                disabled={isSaving}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Rules"}
              </button>
            ) : (
              <button
                onClick={handleApplyJson}
                disabled={isSaving || !jsonText.trim()}
                className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50"
              >
                {isSaving ? "Saving..." : isTemplateMode ? "Save JSON to Template" : "Apply JSON"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
