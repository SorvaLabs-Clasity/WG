import re

with open("frontend/src/pages/TemplatesPage.tsx", "r") as f:
    content = f.read()

# 1. Add imports for Editor and prism
imports = """import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import "prismjs/components/prism-json";
import "prismjs/themes/prism.css";
"""

if "react-simple-code-editor" not in content:
    content = content.replace('import type { BranchRule } from "../types/Template";', 'import type { BranchRule } from "../types/Template";\n' + imports)

# 2. Update toggleJsonMode
old_toggle_json = """  const toggleJsonMode = (idx: number) => {
    const updated = [...branchRules];
    const rule = updated[idx];
    if (!rule.jsonMode) {
      // Switching to JSON mode
      rule.jsonString = JSON.stringify(rule.protection, null, 2);
      rule.jsonError = "";
    } else {
      // Switching to Visual mode: try parsing
      try {
        if (rule.jsonString) {
          rule.protection = JSON.parse(rule.jsonString);
        }
        rule.jsonError = "";
      } catch (err) {
        rule.jsonError = "Invalid JSON. Please fix errors before switching back.";
        setBranchRules(updated);
        return;
      }
    }
    rule.jsonMode = !rule.jsonMode;
    setBranchRules(updated);
  };"""

new_toggle_json = """  const toggleJsonMode = (idx: number) => {
    const updated = [...branchRules];
    const rule = updated[idx];
    if (!rule.jsonMode) {
      // Switching to JSON mode
      rule.jsonString = JSON.stringify(rule.protection || {}, null, 2);
      rule.jsonError = "";
    } else {
      // Switching to Visual mode: try parsing
      try {
        if (rule.jsonString) {
          const parsed = JSON.parse(rule.jsonString);
          rule.protection = Object.keys(parsed).length === 0 ? null : parsed;
        } else {
          rule.protection = null;
        }
        rule.jsonError = "";
      } catch (err) {
        rule.jsonError = "Invalid JSON. Please fix errors before switching back.";
        setBranchRules(updated);
        return;
      }
    }
    rule.jsonMode = !rule.jsonMode;
    setBranchRules(updated);
  };"""

content = content.replace(old_toggle_json, new_toggle_json)

# 3. Update the rule rendering block

start_str = """                      <div className="flex items-start border-t border-gray-100 pt-3">"""
end_str = """                              </div>
                            </details>
                          </div>
                        )}
                      </div>"""

start_idx = content.find(start_str)
end_idx = content.find(end_str) + len(end_str)

if start_idx == -1 or end_idx < len(end_str):
    print("Could not find render block")
    exit(1)

new_render_block = """                      <div className="flex items-center justify-between border-t border-gray-100 pt-3 mt-3">
                        {rule.jsonMode ? (
                          <div className="flex-1 text-sm font-semibold text-gh-textBase">
                            Raw JSON Configuration
                          </div>
                        ) : (
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
                        )}
                        
                        <button
                          type="button"
                          onClick={() => toggleJsonMode(idx)}
                          className="px-3 py-1 text-[11px] font-semibold text-gh-blue hover:text-gh-blueHover hover:bg-blue-50 rounded-md transition-colors flex items-center gap-1.5"
                        >
                          {rule.jsonMode ? (
                            <><i className="fa-solid fa-code"></i> Visual Editor</>
                          ) : (
                            <><i className="fa-solid fa-brackets-curly"></i> Edit JSON</>
                          )}
                        </button>
                      </div>

                      {rule.jsonMode ? (
                        <div className="mt-3 flex flex-col gap-2">
                          <Editor
                            value={rule.jsonString || ""}
                            onValueChange={(val) => updateJsonString(idx, val)}
                            highlight={(code) => Prism.highlight(code, Prism.languages.json, "json")}
                            padding={12}
                            className={`font-mono text-[13px] border rounded-md bg-gray-50 text-gray-800 ${rule.jsonError ? 'border-red-400 focus-within:border-red-500 focus-within:ring-1 focus-within:ring-red-200' : 'border-gray-300 focus-within:border-gh-blue focus-within:ring-1 focus-within:ring-blue-100'}`}
                            style={{
                              minHeight: '200px',
                              backgroundColor: '#f6f8fa',
                            }}
                          />
                          {rule.jsonError && (
                            <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                              <i className="fa-solid fa-triangle-exclamation"></i> {rule.jsonError}
                            </p>
                          )}
                        </div>
                      ) : (
                        rule.protection && (
                          <div className="mt-4 pl-4 border-l border-gray-100 space-y-3">
                            <div className="flex items-center gap-4 bg-gray-50 p-1.5 rounded-md border border-gray-200/60 mb-3 w-fit">
                              <button
                                type="button"
                                onClick={() => updateRuleProtectionField(idx, 'type', 'classic')}
                                className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                                  rule.protection.type === 'classic' 
                                    ? 'bg-white shadow-sm text-gh-textBase border border-gray-200' 
                                    : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                                }`}
                              >
                                Classic Protection
                              </button>
                              <button
                                type="button"
                                onClick={() => updateRuleProtectionField(idx, 'type', 'ruleset')}
                                className={`px-3 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                                  rule.protection.type === 'ruleset' 
                                    ? 'bg-white shadow-sm text-gh-textBase border border-gray-200' 
                                    : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                                }`}
                              >
                                Repository Ruleset
                              </button>
                            </div>

                            <div className="flex items-center gap-3">
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

                            <div className="grid grid-cols-1 gap-y-2">
                              {[
                                { field: 'dismissStaleReviews', label: 'Dismiss stale reviews', desc: 'When new commits are pushed' },
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

                            <details className="group/details mt-2">
                              <summary className="text-[11px] font-semibold text-gh-blue cursor-pointer hover:underline list-none flex items-center gap-1 select-none">
                                <i className="fa-solid fa-chevron-right text-[9px] group-open/details:rotate-90 transition-transform"></i>
                                Advanced Settings
                              </summary>
                              <div className="pt-3 mt-2 border-t border-dashed border-gray-200 grid grid-cols-1 xl:grid-cols-2 gap-x-4 gap-y-3">
                                {[
                                  { field: 'requireCodeOwnerReviews', label: 'Require Code Owner review', desc: 'If code owner is specified' },
                                  { field: 'requireConversationResolution', label: 'Require conversation resolution', desc: 'All comments must be resolved' },
                                  { field: 'requireStatusChecks', label: 'Require status checks', desc: 'Checks must pass' },
                                  { field: 'strictStatusChecks', label: 'Require up to date branch', desc: 'Before merging' },
                                  { field: 'requireSignedCommits', label: 'Require signed commits', desc: 'All commits must be signed' },
                                  { field: 'requireLinearHistory', label: 'Require linear history', desc: 'Prevent merge commits' },
                                  { field: 'enforceAdmins', label: 'Enforce for admins', desc: 'Rules apply to admins too' },
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
                            </details>
                          </div>
                        )
                      )}"""

content = content[:start_idx] + new_render_block + content[end_idx:]

with open("frontend/src/pages/TemplatesPage.tsx", "w") as f:
    f.write(content)
print("done")
