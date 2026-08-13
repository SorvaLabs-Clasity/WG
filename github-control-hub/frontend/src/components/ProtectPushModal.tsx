import { useState, useEffect } from "react";
import type { PushRule } from "../types/Protection";
import { Toggle, Section, BypassActorsSection } from "./RulesetShared";
import type { BypassActor } from "./RulesetShared";

export const DEFAULT_PUSH_PROTECTION: PushRule = {
  rulesetName: "",
  enforcement: "active",
  filePathRestriction: undefined,
  maxFilePathLength: undefined,
  maxFileSize: undefined,
  fileExtensionRestriction: undefined,
  bypassActors: [],
};

export function parseGitHubPushRulesetJson(json: any): PushRule {
  const result: PushRule = { ...DEFAULT_PUSH_PROTECTION };

  if (Array.isArray(json)) {
    parseRules(json, result);
    return result;
  }

  if (json.name) result.rulesetName = json.name;
  if (json.enforcement) result.enforcement = json.enforcement as PushRule["enforcement"];

  if (json.bypass_actors && json.bypass_actors.length > 0) {
    result.bypassActors = json.bypass_actors.map((a: any) => ({
      actor_id: a.actor_id,
      actor_type: a.actor_type,
      bypass_mode: a.bypass_mode || "always",
    }));
  }

  parseRules(json.rules || [], result);
  return result;
}

function parseRules(rules: any[], result: PushRule) {
  result.filePathRestriction = undefined;
  result.maxFilePathLength = undefined;
  result.maxFileSize = undefined;
  result.fileExtensionRestriction = undefined;

  for (const rule of rules) {
    switch (rule.type) {
      case "file_path_restriction":
        result.filePathRestriction = {
          restrictedFilePaths: rule.parameters?.restricted_file_paths || [],
        };
        break;
      case "max_file_path_length":
        result.maxFilePathLength = rule.parameters?.max_file_path_length;
        break;
      case "max_file_size":
        result.maxFileSize = rule.parameters?.max_file_size;
        break;
      case "file_extension_restriction":
        result.fileExtensionRestriction = {
          restrictedFileExtensions: rule.parameters?.restricted_file_extensions || [],
        };
        break;
    }
  }
}

interface ProtectPushModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialData?: PushRule;
  onSave: (rule: PushRule) => void;
  isSaving: boolean;
  isTemplateMode?: boolean;
}

export default function ProtectPushModal({
  isOpen,
  onClose,
  initialData,
  onSave,
  isSaving,
  isTemplateMode = false,
}: ProtectPushModalProps) {
  const [rule, setRule] = useState<PushRule>({ ...DEFAULT_PUSH_PROTECTION });
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [enforceAdmins, setEnforceAdmins] = useState(true);

  // File path restriction input
  const [filePathInput, setFilePathInput] = useState("");
  // File extension restriction input
  const [fileExtInput, setFileExtInput] = useState("");

  useEffect(() => {
    if (isOpen) {
      if (initialData?.rawJson) {
        setRule(initialData);
        setMode("json");
        setJsonText(JSON.stringify(initialData.rawJson, null, 2));
      } else {
        setRule(initialData || { ...DEFAULT_PUSH_PROTECTION });
        setMode("form");
        setJsonText("");
      }
      const bypass = initialData?.bypassActors || [];
      setEnforceAdmins(bypass.length === 0);
      setJsonError("");
      setFilePathInput("");
      setFileExtInput("");
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
        onSave({ ...base, rawJson: parsed, rulesetName: parsed.name || rule.rulesetName } as PushRule);
      } else {
        const imported = parseGitHubPushRulesetJson(parsed);
        onSave(imported);
      }
    } catch {
      setJsonError("Invalid JSON. Please paste a valid GitHub push ruleset JSON.");
    }
  };

  if (!isOpen) return null;

  const ruleCount = [
    rule.filePathRestriction && rule.filePathRestriction.restrictedFilePaths.length > 0,
    rule.maxFilePathLength && rule.maxFilePathLength > 0,
    rule.maxFileSize && rule.maxFileSize > 0,
    rule.fileExtensionRestriction && rule.fileExtensionRestriction.restrictedFileExtensions.length > 0,
  ].filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white dark:bg-slate-900 rounded-[12px] shadow-modal border border-black/10 dark:border-slate-700 w-full max-w-[680px] relative z-10 animate-slide-up overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gh-border dark:border-slate-700 flex items-center justify-between bg-white dark:bg-slate-900 pt-5 shrink-0">
          <h3 className="text-lg font-bold text-gray-900 dark:text-white tracking-tight flex items-center gap-2">
            <i className="ph-bold ph-upload-simple text-gh-blue"></i>
            Push Ruleset Configuration
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 dark:text-slate-500 hover:text-gray-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/5 transition-colors absolute right-4 top-4"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          <div className="flex items-center gap-2 bg-gray-50 dark:bg-slate-800 p-1 rounded-md border border-gray-200 dark:border-slate-700 w-fit">
            <button
              type="button"
              onClick={() => {
                if (mode === "json" && jsonText.trim()) {
                  if (!confirm("Switching to form mode will discard any pasted JSON. Continue?")) return;
                }
                setMode("form");
              }}
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
                  Paste a GitHub push ruleset JSON below.
                </p>
                <textarea
                  value={jsonText}
                  onChange={e => { setJsonText(e.target.value); setJsonError(""); }}
                  placeholder='Paste the full push ruleset JSON here...'
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
                  <label className="text-xs font-semibold text-gh-muted dark:text-slate-400 uppercase tracking-wider block mb-1.5">Ruleset Name <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={rule.rulesetName || ""}
                    onChange={e => update("rulesetName", e.target.value)}
                    placeholder="Push Protection Ruleset"
                    className={`w-full px-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200 ${!(rule.rulesetName?.trim()) ? "border-red-300 dark:border-red-500/50" : "border-gray-300 dark:border-slate-600"}`}
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
                <h4 className="text-xs font-bold text-gh-muted dark:text-slate-400 uppercase tracking-wider">Push Rules</h4>

                <Section title="File Path Restrictions" icon="ph-fill ph-file-dashed" defaultOpen={!!(rule.filePathRestriction && rule.filePathRestriction.restrictedFilePaths.length > 0)}>
                  <p className="text-[12px] text-gh-muted dark:text-slate-400 mb-3">
                    Prevent pushes that include changes to specified file paths.
                  </p>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {(rule.filePathRestriction?.restrictedFilePaths || []).map(p => (
                      <span key={p} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-50 dark:bg-rose-950/50 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800 text-xs font-mono">
                        {p}
                        <button
                          type="button"
                          onClick={() => {
                            const paths = (rule.filePathRestriction?.restrictedFilePaths || []).filter(x => x !== p);
                            update("filePathRestriction", paths.length > 0 ? { restrictedFilePaths: paths } : undefined);
                          }}
                          className="text-rose-400 dark:text-rose-600 hover:text-red-600"
                        >
                          <i className="ph-bold ph-x text-[10px]"></i>
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={filePathInput}
                      onChange={e => setFilePathInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && filePathInput.trim()) {
                          e.preventDefault();
                          const paths = [...(rule.filePathRestriction?.restrictedFilePaths || []), filePathInput.trim()];
                          update("filePathRestriction", { restrictedFilePaths: paths });
                          setFilePathInput("");
                        }
                      }}
                      placeholder="e.g. .github/workflows/** + Enter"
                      className="flex-1 px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (filePathInput.trim()) {
                          const paths = [...(rule.filePathRestriction?.restrictedFilePaths || []), filePathInput.trim()];
                          update("filePathRestriction", { restrictedFilePaths: paths });
                          setFilePathInput("");
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-semibold bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-700 text-gh-textBase dark:text-slate-200"
                    >
                      Add
                    </button>
                  </div>
                </Section>

                <Section title="File Size Limit" icon="ph-fill ph-file-arrow-up" defaultOpen={!!(rule.maxFileSize && rule.maxFileSize > 0)}>
                  <p className="text-[12px] text-gh-muted dark:text-slate-400 mb-3">
                    Limit the size of files that can be pushed. Value in megabytes (MB).
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={0}
                      value={rule.maxFileSize || ""}
                      onChange={e => update("maxFileSize", e.target.value ? Number(e.target.value) : undefined)}
                      placeholder="100"
                      className="w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                    />
                    <span className="text-sm text-gh-muted dark:text-slate-400">MB</span>
                  </div>
                </Section>

                <Section title="File Path Length" icon="ph-fill ph-text-align-left" defaultOpen={!!(rule.maxFilePathLength && rule.maxFilePathLength > 0)}>
                  <p className="text-[12px] text-gh-muted dark:text-slate-400 mb-3">
                    Limit the length of file paths in pushed commits.
                  </p>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={0}
                      value={rule.maxFilePathLength || ""}
                      onChange={e => update("maxFilePathLength", e.target.value ? Number(e.target.value) : undefined)}
                      placeholder="256"
                      className="w-32 px-3 py-1.5 text-sm border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                    />
                    <span className="text-sm text-gh-muted dark:text-slate-400">characters</span>
                  </div>
                </Section>

                <Section title="File Extension Restrictions" icon="ph-fill ph-file-x" defaultOpen={!!(rule.fileExtensionRestriction && rule.fileExtensionRestriction.restrictedFileExtensions.length > 0)}>
                  <p className="text-[12px] text-gh-muted dark:text-slate-400 mb-3">
                    Block pushes that include files with specific extensions.
                  </p>
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {(rule.fileExtensionRestriction?.restrictedFileExtensions || []).map(ext => (
                      <span key={ext} className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-xs font-mono">
                        .{ext}
                        <button
                          type="button"
                          onClick={() => {
                            const exts = (rule.fileExtensionRestriction?.restrictedFileExtensions || []).filter(x => x !== ext);
                            update("fileExtensionRestriction", exts.length > 0 ? { restrictedFileExtensions: exts } : undefined);
                          }}
                          className="text-amber-400 dark:text-amber-600 hover:text-red-600"
                        >
                          <i className="ph-bold ph-x text-[10px]"></i>
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={fileExtInput}
                      onChange={e => setFileExtInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter" && fileExtInput.trim()) {
                          e.preventDefault();
                          const ext = fileExtInput.trim().replace(/^\./, "");
                          const exts = [...(rule.fileExtensionRestriction?.restrictedFileExtensions || []), ext];
                          update("fileExtensionRestriction", { restrictedFileExtensions: exts });
                          setFileExtInput("");
                        }
                      }}
                      placeholder="e.g. exe, dll, zip + Enter"
                      className="flex-1 px-3 py-1.5 text-sm font-mono border border-gray-300 dark:border-slate-600 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue dark:bg-slate-800 dark:text-slate-200"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (fileExtInput.trim()) {
                          const ext = fileExtInput.trim().replace(/^\./, "");
                          const exts = [...(rule.fileExtensionRestriction?.restrictedFileExtensions || []), ext];
                          update("fileExtensionRestriction", { restrictedFileExtensions: exts });
                          setFileExtInput("");
                        }
                      }}
                      className="px-3 py-1.5 text-xs font-semibold bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-md hover:bg-gray-50 dark:hover:bg-slate-700 text-gh-textBase dark:text-slate-200"
                    >
                      Add
                    </button>
                  </div>
                </Section>

                <BypassActorsSection
                  enforceAdmins={enforceAdmins}
                  onEnforceAdminsChange={v => {
                    setEnforceAdmins(v);
                    if (v) update("bypassActors", []);
                  }}
                  bypassActors={(rule.bypassActors || []) as BypassActor[]}
                  onBypassActorsChange={v => update("bypassActors", v)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gh-border dark:border-slate-700 bg-gray-50/50 dark:bg-slate-800/50 flex flex-col gap-3 rounded-b-[12px] shrink-0">
          {/* What you're saving */}
          <div className={`flex items-center gap-2 text-[11px] font-medium rounded-md px-3 py-1.5 ${
            mode === "json"
              ? "bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800"
              : "bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800"
          }`}>
            <i className={`fa-solid ${mode === "json" ? "fa-code" : "fa-upload"} text-[10px]`}></i>
            {mode === "json"
              ? "This will save the raw JSON as-is"
              : `Push ruleset${rule.rulesetName ? `: ${rule.rulesetName}` : ""}${ruleCount > 0 ? ` \u2022 ${ruleCount} rule${ruleCount !== 1 ? "s" : ""}` : ""}`
            }
          </div>
          <div className="flex items-center justify-end gap-3">
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
                  onSave({ ...formRule } as PushRule);
                }}
                disabled={isSaving || !(rule.rulesetName?.trim())}
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
