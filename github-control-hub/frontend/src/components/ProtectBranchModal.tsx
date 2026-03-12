import { useState, useEffect, useMemo } from "react";
import type { BranchRule } from "../types/Template";
import { TagInput } from "./TagInput";
import { useOrgActors } from "../hooks/useOrgConfig";

export const DEFAULT_PROTECTION: NonNullable<BranchRule["protection"]> = {
  type: "ruleset",
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
  requireCodeQuality: false,
  codeQualitySeverity: "errors",
  copilotCodeReview: false,
  copilotReviewOnPush: false,
  copilotReviewDraftPrs: false,
  enforcement: "active",
  bypassActors: [],
  restrictPushes: false,
  restrictMatchingBranchCreation: false,
  pushRestrictionUsers: [],
  pushRestrictionTeams: [],
  pushRestrictionApps: [],
};

/**
 * Parse a GitHub ruleset into our internal protection form fields.
 * Accepts either:
 *   - The full ruleset JSON (with name, enforcement, rules, etc.)
 *   - Just the "rules" array directly
 */
export function parseGitHubRulesetJson(json: any): NonNullable<BranchRule["protection"]> {
  const result: NonNullable<BranchRule["protection"]> = { ...DEFAULT_PROTECTION, type: "ruleset" };

  let rules: any[];

  if (Array.isArray(json)) {
    rules = json;
  } else {
    if (json.name) result.rulesetName = json.name;
    if (json.enforcement) result.enforcement = json.enforcement;
    result.enforceAdmins = !json.bypass_actors || json.bypass_actors.length === 0;
    if (json.bypass_actors && json.bypass_actors.length > 0) {
      result.bypassActors = json.bypass_actors.map((a: any) => ({
        actor_id: a.actor_id,
        actor_type: a.actor_type,
        bypass_mode: a.bypass_mode || "always",
      }));
    }
    rules = json.rules || [];
  }

  for (const rule of rules) {
    switch (rule.type) {
      case "creation":
        result.restrictCreations = true;
        break;
      case "update":
        result.restrictUpdates = true;
        break;
      case "deletion":
        result.preventDeletion = true;
        break;
      case "non_fast_forward":
        result.preventForcePush = true;
        break;
      case "required_linear_history":
        result.requireLinearHistory = true;
        break;
      case "required_signatures":
        result.requireSignedCommits = true;
        break;
      case "pull_request": {
        result.requirePr = true;
        const p = rule.parameters || {};
        result.requiredApprovals = p.required_approving_review_count ?? 1;
        result.dismissStaleReviews = p.dismiss_stale_reviews_on_push ?? false;
        result.requireCodeOwnerReviews = p.require_code_owner_review ?? false;
        result.requireLastPushApproval = p.require_last_push_approval ?? false;
        result.requireConversationResolution = p.required_review_thread_resolution ?? false;
        if (p.allowed_merge_methods) result.allowedMergeMethods = p.allowed_merge_methods;
        break;
      }
      case "required_status_checks": {
        result.requireStatusChecks = true;
        const p = rule.parameters || {};
        result.strictStatusChecks = p.strict_required_status_checks_policy ?? false;
        result.doNotRequireStatusChecksOnCreation = p.do_not_enforce_on_create ?? false;
        if (p.required_status_checks && Array.isArray(p.required_status_checks)) {
          result.statusCheckContexts = p.required_status_checks.map((c: any) => c.context).filter(Boolean);
        }
        break;
      }
      case "required_deployments": {
        result.requireDeployments = true;
        const p = rule.parameters || {};
        result.requiredDeploymentEnvironments = p.required_deployment_environments || [];
        break;
      }
      case "required_code_scanning":
      case "code_scanning": {
        result.requireCodeScanning = true;
        const tools = rule.parameters?.code_scanning_tools;
        if (tools && tools.length > 0) {
          result.codeScanningTool = tools[0].tool || "CodeQL";
          result.codeScanningAlertsThreshold = tools[0].alerts_threshold || "errors";
          result.codeScanningSecurityAlertsThreshold = tools[0].security_alerts_threshold || "high_or_higher";
        }
        break;
      }
      case "code_quality": {
        result.requireCodeQuality = true;
        result.codeQualitySeverity = rule.parameters?.severity || "errors";
        break;
      }
      case "copilot_code_review": {
        result.copilotCodeReview = true;
        result.copilotReviewOnPush = rule.parameters?.review_on_push ?? false;
        result.copilotReviewDraftPrs = rule.parameters?.review_draft_pull_requests ?? false;
        break;
      }
    }
  }

  return result;
}

interface ProtectBranchModalProps {
  isOpen: boolean;
  onClose: () => void;
  branch: string;
  branches?: string[];
  initialData?: NonNullable<BranchRule["protection"]>;
  onSave: (rules: NonNullable<BranchRule["protection"]>, targetBranch: string) => void;
  onImportJson?: (json: any) => void;
  isSaving: boolean;
  isCreating?: boolean;
  isTemplateMode?: boolean;
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

type BypassActor = NonNullable<NonNullable<BranchRule["protection"]>["bypassActors"]>[number];

function BypassActorsSection({
  enforceAdmins,
  onEnforceAdminsChange,
  bypassActors,
  onBypassActorsChange,
}: {
  enforceAdmins: boolean;
  onEnforceAdminsChange: (v: boolean) => void;
  bypassActors: BypassActor[];
  onBypassActorsChange: (v: BypassActor[]) => void;
}) {
  const { data: actors } = useOrgActors(true);
  const [search, setSearch] = useState("");

  const isSelected = (type: BypassActor["actor_type"], id: number) =>
    bypassActors.some(a => a.actor_type === type && a.actor_id === id);

  const getMode = (type: BypassActor["actor_type"], id: number): "always" | "pull_request" =>
    bypassActors.find(a => a.actor_type === type && a.actor_id === id)?.bypass_mode || "always";

  const toggle = (type: BypassActor["actor_type"], id: number) => {
    if (isSelected(type, id)) {
      onBypassActorsChange(bypassActors.filter(a => !(a.actor_type === type && a.actor_id === id)));
    } else {
      onBypassActorsChange([...bypassActors, { actor_id: id, actor_type: type, bypass_mode: "always" }]);
    }
  };

  const setMode = (type: BypassActor["actor_type"], id: number, mode: "always" | "pull_request") => {
    onBypassActorsChange(bypassActors.map(a =>
      a.actor_type === type && a.actor_id === id ? { ...a, bypass_mode: mode } : a
    ));
  };

  const filteredRoles = useMemo(() => {
    if (!actors) return [];
    return actors.roles.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search]);

  const filteredTeams = useMemo(() => {
    if (!actors) return [];
    return actors.teams.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search]);

  const filteredApps = useMemo(() => {
    if (!actors) return [];
    return actors.apps.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search]);

  return (
    <Section title="Bypass & Enforcement" icon="ph-fill ph-crown" defaultOpen={!enforceAdmins || bypassActors.length > 0}>
      <Toggle
        checked={enforceAdmins}
        onChange={v => {
          onEnforceAdminsChange(v);
          if (v) onBypassActorsChange([]);
        }}
        label="Do not allow bypassing above rules"
        desc="When enabled, no one can bypass these rules. Uncheck to configure specific bypass actors."
      />

      {!enforceAdmins && (
        <div className="mt-3 ml-7 space-y-3">
          <p className="text-[12px] text-gh-muted">
            Select roles, teams, and apps that are allowed to bypass these rules.
          </p>

          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <i className="ph ph-magnifying-glass text-gray-400 text-sm"></i>
            </div>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search roles, teams, apps..."
              className="w-full pl-9 pr-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-gh-blue/20 focus:border-gh-blue transition-all"
            />
          </div>

          <div className="border border-gray-200 rounded-lg bg-white overflow-hidden max-h-56 overflow-y-auto">
            {!actors ? (
              <div className="px-4 py-6 text-center text-sm text-gh-muted">
                <i className="ph ph-spinner ph-spin mr-2"></i>Loading...
              </div>
            ) : (
              <>
                {filteredRoles.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gh-muted uppercase tracking-wider border-b border-gray-100 sticky top-0">
                      Roles
                    </div>
                    {filteredRoles.map(role => (
                      <ActorRow
                        key={`role-${role.id}`}
                        icon="ph-fill ph-shield-star"
                        name={role.name}
                        desc={role.description}
                        selected={isSelected("RepositoryRole", role.id)}
                        onToggle={() => toggle("RepositoryRole", role.id)}
                        mode={getMode("RepositoryRole", role.id)}
                        onModeChange={m => setMode("RepositoryRole", role.id, m)}
                      />
                    ))}
                  </div>
                )}
                {filteredTeams.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gh-muted uppercase tracking-wider border-b border-gray-100 sticky top-0">
                      Teams
                    </div>
                    {filteredTeams.map(team => (
                      <ActorRow
                        key={`team-${team.id}`}
                        icon="ph-fill ph-users-three"
                        name={team.name}
                        desc={`@${team.slug}`}
                        selected={isSelected("Team", team.id)}
                        onToggle={() => toggle("Team", team.id)}
                        mode={getMode("Team", team.id)}
                        onModeChange={m => setMode("Team", team.id, m)}
                      />
                    ))}
                  </div>
                )}
                {filteredApps.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gh-muted uppercase tracking-wider border-b border-gray-100 sticky top-0">
                      Apps
                    </div>
                    {filteredApps.map(app => (
                      <ActorRow
                        key={`app-${app.id}`}
                        icon="ph-fill ph-plugs-connected"
                        name={app.name}
                        desc={`App ID: ${app.id}`}
                        selected={isSelected("Integration", app.id)}
                        onToggle={() => toggle("Integration", app.id)}
                        mode={getMode("Integration", app.id)}
                        onModeChange={m => setMode("Integration", app.id, m)}
                      />
                    ))}
                  </div>
                )}
                {filteredRoles.length === 0 && filteredTeams.length === 0 && filteredApps.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gh-muted">
                    {search ? "No matches found" : "No actors available"}
                  </div>
                )}
              </>
            )}
          </div>

          {bypassActors.length > 0 && (
            <div className="text-[11px] text-gh-muted">
              {bypassActors.length} bypass actor{bypassActors.length !== 1 ? "s" : ""} selected
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function ActorRow({
  icon,
  name,
  desc,
  selected,
  onToggle,
  mode,
  onModeChange,
}: {
  icon: string;
  name: string;
  desc: string;
  selected: boolean;
  onToggle: () => void;
  mode: "always" | "pull_request";
  onModeChange: (m: "always" | "pull_request") => void;
}) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors ${selected ? "bg-blue-50/30" : ""}`}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue shrink-0"
      />
      <i className={`${icon} text-gray-500 text-sm shrink-0`}></i>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-gh-textBase">{name}</span>
        <span className="text-[11px] text-gh-muted ml-2">{desc}</span>
      </div>
      {selected && (
        <select
          value={mode}
          onChange={e => onModeChange(e.target.value as "always" | "pull_request")}
          className="text-[11px] px-2 py-1 border border-gray-200 rounded-md bg-white text-gh-textBase focus:outline-none focus:ring-1 focus:ring-gh-blue shrink-0"
        >
          <option value="always">Always</option>
          <option value="pull_request">PRs only</option>
        </select>
      )}
    </div>
  );
}

function PushRestrictionsSection({
  enforceAdmins,
  onEnforceAdminsChange,
  restrictPushes,
  onRestrictPushesChange,
  restrictMatchingBranchCreation,
  onRestrictMatchingBranchCreationChange,
  users,
  onUsersChange,
  teams,
  onTeamsChange,
  apps,
  onAppsChange,
}: {
  enforceAdmins: boolean;
  onEnforceAdminsChange: (v: boolean) => void;
  restrictPushes: boolean;
  onRestrictPushesChange: (v: boolean) => void;
  restrictMatchingBranchCreation: boolean;
  onRestrictMatchingBranchCreationChange: (v: boolean) => void;
  users: string[];
  onUsersChange: (v: string[]) => void;
  teams: string[];
  onTeamsChange: (v: string[]) => void;
  apps: string[];
  onAppsChange: (v: string[]) => void;
}) {
  const { data: actors } = useOrgActors(true);
  const [search, setSearch] = useState("");

  const filteredTeams = useMemo(() => {
    if (!actors) return [];
    return actors.teams.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search]);

  const filteredApps = useMemo(() => {
    if (!actors) return [];
    return actors.apps.filter(a => a.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search]);

  return (
    <Section title="Access & Enforcement" icon="ph-fill ph-crown" defaultOpen={enforceAdmins || restrictPushes}>
      <Toggle
        checked={enforceAdmins}
        onChange={onEnforceAdminsChange}
        label="Enforce for admins"
        desc="Include administrators in these protection rules."
      />

      <div className="border-t border-gray-100 pt-3 mt-3">
        <Toggle
          checked={restrictPushes}
          onChange={v => {
            onRestrictPushesChange(v);
            if (!v) {
              onUsersChange([]);
              onTeamsChange([]);
              onAppsChange([]);
              onRestrictMatchingBranchCreationChange(false);
            }
          }}
          label="Restrict who can push to matching branches"
          desc="Specify people, teams, or apps allowed to push to matching branches. Required status checks will still prevent these people, teams, and apps from merging if the checks fail."
        />

        {restrictPushes && (
          <div className="mt-3 ml-7 space-y-3">
            <Toggle
              checked={restrictMatchingBranchCreation}
              onChange={onRestrictMatchingBranchCreationChange}
              label="Restrict pushes that create matching branches"
              desc="Only people, teams, or apps allowed to push will be able to create new branches matching this rule."
            />

            <div className="border-t border-gray-100 pt-3">
              <label className="text-xs font-semibold text-gh-muted block mb-1.5">Allowed Users</label>
              <TagInput
                tags={users}
                onChange={onUsersChange}
                placeholder="Type GitHub usernames and press Enter"
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-gh-muted block mb-2">Allowed Teams</label>
              <div className="relative mb-2">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <i className="ph ph-magnifying-glass text-gray-400 text-sm"></i>
                </div>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search teams and apps..."
                  className="w-full pl-9 pr-3 py-2 text-[13px] border border-gray-200 rounded-lg bg-gray-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-gh-blue/20 focus:border-gh-blue transition-all"
                />
              </div>
              <div className="border border-gray-200 rounded-lg bg-white overflow-hidden max-h-40 overflow-y-auto">
                {!actors ? (
                  <div className="px-4 py-4 text-center text-sm text-gh-muted">
                    <i className="ph ph-spinner ph-spin mr-2"></i>Loading...
                  </div>
                ) : (
                  <>
                    {filteredTeams.length > 0 && (
                      <div>
                        <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gh-muted uppercase tracking-wider border-b border-gray-100 sticky top-0">
                          Teams
                        </div>
                        {filteredTeams.map(team => (
                          <label key={team.slug} className="flex items-center gap-3 px-3 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer transition-colors">
                            <input
                              type="checkbox"
                              checked={teams.includes(team.slug)}
                              onChange={e => {
                                if (e.target.checked) onTeamsChange([...teams, team.slug]);
                                else onTeamsChange(teams.filter(t => t !== team.slug));
                              }}
                              className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue shrink-0"
                            />
                            <i className="ph-fill ph-users-three text-gray-500 text-sm"></i>
                            <span className="text-sm text-gh-textBase">{team.name}</span>
                            <span className="text-[11px] text-gh-muted">@{team.slug}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {filteredApps.length > 0 && (
                      <div>
                        <div className="px-3 py-1.5 bg-gray-50 text-[10px] font-bold text-gh-muted uppercase tracking-wider border-b border-gray-100 sticky top-0">
                          Apps
                        </div>
                        {filteredApps.map(app => (
                          <label key={app.slug} className="flex items-center gap-3 px-3 py-2 border-b border-gray-50 last:border-0 hover:bg-gray-50/50 cursor-pointer transition-colors">
                            <input
                              type="checkbox"
                              checked={apps.includes(app.slug)}
                              onChange={e => {
                                if (e.target.checked) onAppsChange([...apps, app.slug]);
                                else onAppsChange(apps.filter(a => a !== app.slug));
                              }}
                              className="w-4 h-4 text-gh-blue border-gray-300 rounded focus:ring-gh-blue shrink-0"
                            />
                            <i className="ph-fill ph-plugs-connected text-gray-500 text-sm"></i>
                            <span className="text-sm text-gh-textBase">{app.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {filteredTeams.length === 0 && filteredApps.length === 0 && (
                      <div className="px-4 py-4 text-center text-sm text-gh-muted">
                        {search ? "No matches found" : "No teams or apps available"}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

export default function ProtectBranchModal({
  isOpen,
  onClose,
  branch,
  branches = [],
  initialData,
  onSave,
  onImportJson,
  isSaving,
  isCreating = false,
  isTemplateMode = false,
}: ProtectBranchModalProps) {
  const [protectRules, setProtectRules] = useState(DEFAULT_PROTECTION);
  const [targetBranch, setTargetBranch] = useState("");
  const [mode, setMode] = useState<"form" | "json">("form");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");

  const [pendingTags, setPendingTags] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isOpen) {
      if (initialData?.type === "ruleset_json") {
        setProtectRules(initialData);
        setMode("json");
        setJsonText(JSON.stringify(initialData.rawJson, null, 2));
      } else {
        setProtectRules(initialData || { ...DEFAULT_PROTECTION, type: "ruleset" });
        setMode("form");
        setJsonText("");
      }
      setTargetBranch(branch || "");
      setJsonError("");
    }
  }, [isOpen, initialData, branch]);

  const update = (field: string, val: any) => {
    setProtectRules(prev => ({ ...prev, [field]: val }));
  };

  const handleApplyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!parsed.rules || !Array.isArray(parsed.rules)) {
        setJsonError("Invalid format: expected a GitHub ruleset JSON with a \"rules\" array.");
        return;
      }
      if (!parsed.name && !isTemplateMode) {
        setJsonError("Missing \"name\" field. The ruleset JSON must include a name.");
        return;
      }
      if (isTemplateMode) {
        onSave({ type: "ruleset_json", rawJson: parsed, rulesetName: parsed.name } as any, targetBranch);
      } else if (onImportJson) {
        onImportJson(parsed);
      }
    } catch {
      setJsonError("Invalid JSON. Please paste a valid GitHub ruleset JSON.");
    }
  };

  if (!isOpen) return null;

  const isRuleset = protectRules.type === "ruleset" || protectRules.type === "ruleset_json";
  const hasAnyPendingTags = Object.values(pendingTags).some(Boolean);
  const canSaveForm = mode === "form" && !hasAnyPendingTags && (isCreating && !isTemplateMode ? targetBranch.trim().length > 0 : true);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-[#24292f]/40 backdrop-blur-[3px] animate-fade-in" onClick={onClose}></div>
      <div className="bg-white rounded-[12px] shadow-modal border border-black/10 w-full max-w-[680px] relative z-10 animate-slide-up overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-gh-border flex items-center justify-between bg-white pt-5 shrink-0">
          <h3 className="text-lg font-bold text-gray-900 tracking-tight">
            {isCreating ? "New Protection Rule" : (
              <>Protect Branch: <span className="font-mono bg-gray-100 px-1 rounded text-gh-blue">{targetBranch}</span></>
            )}
          </h3>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-900 hover:bg-black/5 transition-colors absolute right-4 top-4"
          >
            <i className="ph ph-x text-lg"></i>
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Top Controls: Target Branch & Type Selector */}
          {(isCreating || isTemplateMode) && (
            <div className="space-y-5 border-b border-gray-100 pb-5">
              {!isTemplateMode && (
                <div>
                  <label className="block text-[13px] font-semibold text-gh-textBase mb-1.5 flex items-center gap-1.5">
                    Target Branch
                    <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <i className="ph ph-git-branch text-gray-400 text-lg"></i>
                    </div>
                    <input
                      list="branch-options"
                      type="text"
                      value={targetBranch}
                      onChange={(e) => setTargetBranch(e.target.value)}
                      disabled={mode === "json"}
                      placeholder="main or release/*"
                      className={`block w-full pl-9 pr-3 py-2.5 text-[14px] leading-tight text-gh-textBase border border-gh-border rounded-[6px] shadow-sm outline-none focus:ring-[3px] focus:ring-gh-blue/20 focus:border-gh-blue transition-all placeholder:text-gray-400 ${
                        mode === "json" ? "bg-gray-100 text-gray-400 cursor-not-allowed" : "bg-white"
                      }`}
                    />
                    <datalist id="branch-options">
                      {branches.map(b => (
                        <option key={b} value={b} />
                      ))}
                    </datalist>
                  </div>
                  {mode === "json" ? (
                    <p className="mt-1.5 text-[12px] text-amber-600 font-medium">
                      Target branch input is disabled because the ruleset JSON directly dictates the target branches via its <code className="text-xs bg-amber-100 px-1 rounded font-mono">conditions</code> field.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[12px] text-gh-textMuted">
                      Select or type the branch name to protect. For rulesets, you can use patterns like <code className="text-xs bg-gray-100 px-1 rounded font-mono">release/*</code>.
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-[13px] font-semibold text-gh-textBase mb-1.5">
                  Protection Type
                </label>
                <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-md border border-gray-200 w-fit">
                  <button
                    type="button"
                    onClick={() => { update('type', 'ruleset'); setMode('form'); }}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                      protectRules.type === 'ruleset' || protectRules.type === 'ruleset_json'
                        ? 'bg-white shadow-sm text-gh-textBase border border-gray-200/50'
                        : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                    }`}
                  >
                    Repository Ruleset
                  </button>
                  <button
                    type="button"
                    onClick={() => { update('type', 'classic'); setMode('form'); }}
                    className={`px-4 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                      protectRules.type === 'classic'
                        ? 'bg-white shadow-sm text-gh-textBase border border-gray-200/50'
                        : 'text-gh-muted hover:text-gh-textBase transparent border border-transparent'
                    }`}
                  >
                    Classic Protection
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Config Mode Selector (Only when creating a ruleset or in template mode) */}
          {(isCreating || isTemplateMode) && (protectRules.type === "ruleset" || protectRules.type === "ruleset_json") && (
            <div className="flex items-center gap-2 bg-gray-50 p-1 rounded-md border border-gray-200 w-fit">
              <button
                type="button"
                onClick={() => { setMode("form"); update("type", "ruleset"); }}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  mode === "form"
                    ? "bg-white shadow-sm text-gh-textBase border border-gray-200/50"
                    : "text-gh-muted hover:text-gh-textBase border border-transparent"
                }`}
              >
                <i className="ph-bold ph-sliders-horizontal mr-1.5"></i>Form Builder
              </button>
              <button
                type="button"
                onClick={() => setMode("json")}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors ${
                  mode === "json"
                    ? "bg-white shadow-sm text-gh-textBase border border-gray-200/50"
                    : "text-gh-muted hover:text-gh-textBase border border-transparent"
                }`}
              >
                <i className="ph-bold ph-code mr-1.5"></i>Direct JSON
              </button>
            </div>
          )}

          {/* Body: Form or JSON */}
          {mode === "json" ? (
            <div className="space-y-4">
              <div>
                <p className="text-sm text-gh-muted mb-3">
                  Paste a GitHub ruleset JSON below. The target branch field above will be ignored; GitHub will apply the target automatically based on the JSON's <code className="text-xs bg-gray-100 px-1 rounded font-mono">conditions</code>.
                </p>
                <textarea
                  value={jsonText}
                  onChange={e => { setJsonText(e.target.value); setJsonError(""); }}
                  placeholder='Paste the full ruleset JSON here...'
                  rows={14}
                  className="w-full px-4 py-3 text-xs font-mono border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gh-blue bg-gray-50 resize-y"
                />
              </div>
              {jsonError && (
                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <i className="ph-fill ph-warning-circle text-red-500"></i>
                  <span className="text-sm text-red-700">{jsonError}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              {/* Ruleset Name & Enforcement (ruleset only) */}
              {isRuleset && (
                <div className="grid grid-cols-2 gap-4 border-b border-gray-100 pb-4">
                  <div>
                    <label className="text-xs font-semibold text-gh-muted uppercase tracking-wider block mb-1.5">Ruleset Name</label>
                    <input
                      type="text"
                      value={protectRules.rulesetName || ""}
                      onChange={e => update("rulesetName", e.target.value)}
                      placeholder={targetBranch ? `Ruleset for ${targetBranch}` : "My Ruleset"}
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
                      <Toggle checked={!!protectRules.restrictCreations} onChange={v => update("restrictCreations", v)} label="Restrict creations" desc="Only allow users with bypass permission to create matching refs." />
                      <Toggle checked={!!protectRules.restrictUpdates} onChange={v => update("restrictUpdates", v)} label="Restrict updates" desc="Only allow users with bypass permission to update matching refs." />
                      <Toggle checked={protectRules.preventDeletion} onChange={v => update("preventDeletion", v)} label="Restrict deletions" desc="Only allow users with bypass permissions to delete matching refs." />
                    </div>
                  </Section>
                )}

                {/* Commit Requirements */}
                <Section title="Commit Requirements" icon="ph-fill ph-git-commit" defaultOpen={!!(protectRules.requireLinearHistory || protectRules.requireSignedCommits)}>
                  <div className="space-y-3">
                    <Toggle checked={protectRules.requireLinearHistory} onChange={v => update("requireLinearHistory", v)} label="Require linear history" desc="Prevent merge commits from being pushed to matching refs." />
                    <Toggle checked={protectRules.requireSignedCommits} onChange={v => update("requireSignedCommits", v)} label="Require signed commits" desc="Commits pushed to matching refs must have verified signatures." />
                  </div>
                </Section>

                {/* Deployments */}
                {isRuleset && (
                  <Section title="Require Deployments to Succeed" icon="ph-fill ph-rocket-launch" defaultOpen={!!protectRules.requireDeployments}>
                    <Toggle checked={!!protectRules.requireDeployments} onChange={v => update("requireDeployments", v)} label="Require deployments to succeed" desc="Choose which environments must be successfully deployed to before refs can be pushed." />
                    {protectRules.requireDeployments && (
                      <div className="ml-7 mt-2">
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Deployment Environments</label>
                        <TagInput tags={protectRules.requiredDeploymentEnvironments || []} onChange={tags => update("requiredDeploymentEnvironments", tags)} onPendingTextChange={p => setPendingTags(prev => ({ ...prev, envs: p }))} placeholder="e.g. production, staging" />
                      </div>
                    )}
                  </Section>
                )}

                {/* Pull Request Requirements */}
                <Section title="Require a Pull Request Before Merging" icon="ph-fill ph-git-pull-request" defaultOpen={protectRules.requirePr}>
                  <Toggle checked={protectRules.requirePr} onChange={v => update("requirePr", v)} label="Require a pull request before merging" desc="All commits must be made via a pull request before they can be merged." />
                  {protectRules.requirePr && (
                    <div className="ml-7 space-y-4 mt-2">
                      <div>
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Approvals</label>
                        <select value={protectRules.requiredApprovals} onChange={(e) => update('requiredApprovals', Number(e.target.value))} className="block w-40 pl-2 pr-8 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue">
                          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                            <option key={n} value={n}>{n} {n === 1 ? "approval" : "approvals"}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-3">
                        <Toggle checked={protectRules.dismissStaleReviews} onChange={v => update("dismissStaleReviews", v)} label="Dismiss stale pull request approvals when new commits are pushed" desc="New, reviewable commits pushed will dismiss previous PR review approvals." />
                        <Toggle checked={protectRules.requireCodeOwnerReviews} onChange={v => update("requireCodeOwnerReviews", v)} label="Require review from Code Owners" desc="Require an approving review in PRs that modify files with a designated code owner." />
                        <Toggle checked={!!protectRules.requireLastPushApproval} onChange={v => update("requireLastPushApproval", v)} label="Require approval of the most recent reviewable push" desc="The most recent push must be approved by someone other than the person who pushed it." />
                        <Toggle checked={protectRules.requireConversationResolution} onChange={v => update("requireConversationResolution", v)} label="Require conversation resolution before merging" desc="All conversations on code must be resolved before a PR can be merged." />
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
                  <Toggle checked={protectRules.requireStatusChecks} onChange={v => update("requireStatusChecks", v)} label="Require status checks to pass" desc="Choose which status checks must pass before the ref is updated." />
                  {protectRules.requireStatusChecks && (
                    <div className="ml-7 space-y-3 mt-2">
                      <Toggle checked={protectRules.strictStatusChecks} onChange={v => update("strictStatusChecks", v)} label="Require branches to be up to date before merging" desc="PRs targeting a matching branch must be tested with the latest code." />
                      {isRuleset && (
                        <Toggle checked={!!protectRules.doNotRequireStatusChecksOnCreation} onChange={v => update("doNotRequireStatusChecksOnCreation", v)} label="Do not require status checks on creation" desc="Allow repositories and branches to be created if a check would otherwise prohibit it." />
                      )}
                      <div>
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Required Status Checks</label>
                        <TagInput tags={protectRules.statusCheckContexts || []} onChange={tags => update("statusCheckContexts", tags)} onPendingTextChange={p => setPendingTags(prev => ({ ...prev, checks: p }))} placeholder="e.g. build, test, lint" />
                      </div>
                    </div>
                  )}
                </Section>

                {/* Force Push & Deletion (classic) */}
                {!isRuleset && (
                  <Section title="Push & Deletion Restrictions" icon="ph-fill ph-shield-warning" defaultOpen={protectRules.preventForcePush || protectRules.preventDeletion}>
                    <div className="space-y-3">
                      <Toggle checked={protectRules.preventForcePush} onChange={v => update("preventForcePush", v)} label="Block force pushes" desc="Prevent users with push access from force pushing to refs." />
                      <Toggle checked={protectRules.preventDeletion} onChange={v => update("preventDeletion", v)} label="Prevent deletion" desc="Block branch deletion." />
                    </div>
                  </Section>
                )}

                {/* Force Push (ruleset) */}
                {isRuleset && (
                  <Section title="Block Force Pushes" icon="ph-fill ph-shield-warning" defaultOpen={protectRules.preventForcePush}>
                    <Toggle checked={protectRules.preventForcePush} onChange={v => update("preventForcePush", v)} label="Block force pushes" desc="Prevent users with push access from force pushing to refs." />
                  </Section>
                )}

                {/* Code Scanning (ruleset only) */}
                {isRuleset && (
                  <Section title="Require Code Scanning Results" icon="ph-fill ph-bug" defaultOpen={!!protectRules.requireCodeScanning}>
                    <Toggle checked={!!protectRules.requireCodeScanning} onChange={v => update("requireCodeScanning", v)} label="Require code scanning results" desc="Code scanning must be enabled and have results for both the commit and the reference being updated." />
                    {protectRules.requireCodeScanning && (
                      <div className="ml-7 space-y-3 mt-2">
                        <div>
                          <label className="text-xs font-semibold text-gh-muted block mb-1.5">Tool</label>
                          <input type="text" value={protectRules.codeScanningTool || "CodeQL"} onChange={e => update("codeScanningTool", e.target.value)} className="w-48 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-1 focus:ring-gh-blue" />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-xs font-semibold text-gh-muted block mb-1.5">Alerts Threshold</label>
                            <select value={protectRules.codeScanningAlertsThreshold || "errors"} onChange={e => update("codeScanningAlertsThreshold", e.target.value)} className="w-full px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue">
                              <option value="none">None</option>
                              <option value="errors">Errors</option>
                              <option value="errors_and_warnings">Errors & Warnings</option>
                              <option value="all">All</option>
                            </select>
                          </div>
                          <div>
                            <label className="text-xs font-semibold text-gh-muted block mb-1.5">Security Threshold</label>
                            <select value={protectRules.codeScanningSecurityAlertsThreshold || "high_or_higher"} onChange={e => update("codeScanningSecurityAlertsThreshold", e.target.value)} className="w-full px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue">
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

                {/* Code Quality (ruleset only) */}
                {isRuleset && (
                  <Section title="Require Code Quality Results" icon="ph-fill ph-exam" defaultOpen={!!protectRules.requireCodeQuality}>
                    <Toggle checked={!!protectRules.requireCodeQuality} onChange={v => update("requireCodeQuality", v)} label="Require code quality results" desc="Choose which severity levels of code quality results should block PR merges." />
                    {protectRules.requireCodeQuality && (
                      <div className="ml-7 mt-2">
                        <label className="text-xs font-semibold text-gh-muted block mb-1.5">Severity</label>
                        <select value={protectRules.codeQualitySeverity || "errors"} onChange={e => update("codeQualitySeverity", e.target.value)} className="w-48 px-2 py-1.5 text-sm border-gray-300 rounded-md bg-white ring-1 ring-inset ring-gray-200 focus:outline-none focus:ring-gh-blue">
                          <option value="none">None</option>
                          <option value="errors">Errors</option>
                          <option value="errors_and_warnings">Errors & Warnings</option>
                          <option value="all">All</option>
                        </select>
                        <p className="text-[11px] text-gh-muted mt-1">The lowest severity level at which code quality reviews need to be resolved before merging.</p>
                      </div>
                    )}
                  </Section>
                )}

                {/* Copilot Code Review (ruleset only) */}
                {isRuleset && (
                  <Section title="Automatically Request Copilot Code Review" icon="ph-fill ph-sparkle" defaultOpen={!!protectRules.copilotCodeReview}>
                    <Toggle checked={!!protectRules.copilotCodeReview} onChange={v => update("copilotCodeReview", v)} label="Automatically request Copilot code review" desc="Request Copilot code review for new pull requests automatically." />
                    {protectRules.copilotCodeReview && (
                      <div className="ml-7 space-y-3 mt-2">
                        <Toggle checked={!!protectRules.copilotReviewOnPush} onChange={v => update("copilotReviewOnPush", v)} label="Review new pushes" desc="Copilot automatically reviews each new push to the pull request." />
                        <Toggle checked={!!protectRules.copilotReviewDraftPrs} onChange={v => update("copilotReviewDraftPrs", v)} label="Review draft pull requests" desc="Copilot automatically reviews draft PRs before they are marked as ready for review." />
                      </div>
                    )}
                  </Section>
                )}

                {/* Bypass Actors (ruleset only) */}
                {isRuleset && (
                  <BypassActorsSection
                    enforceAdmins={protectRules.enforceAdmins}
                    onEnforceAdminsChange={v => update("enforceAdmins", v)}
                    bypassActors={protectRules.bypassActors || []}
                    onBypassActorsChange={v => update("bypassActors", v)}
                  />
                )}

                {/* Push Restrictions (classic only) */}
                {!isRuleset && (
                  <PushRestrictionsSection
                    enforceAdmins={protectRules.enforceAdmins}
                    onEnforceAdminsChange={v => update("enforceAdmins", v)}
                    restrictPushes={!!protectRules.restrictPushes}
                    onRestrictPushesChange={v => update("restrictPushes", v)}
                    restrictMatchingBranchCreation={!!protectRules.restrictMatchingBranchCreation}
                    onRestrictMatchingBranchCreationChange={v => update("restrictMatchingBranchCreation", v)}
                    users={protectRules.pushRestrictionUsers || []}
                    onUsersChange={v => update("pushRestrictionUsers", v)}
                    teams={protectRules.pushRestrictionTeams || []}
                    onTeamsChange={v => update("pushRestrictionTeams", v)}
                    apps={protectRules.pushRestrictionApps || []}
                    onAppsChange={v => update("pushRestrictionApps", v)}
                  />
                )}
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-gh-border bg-gray-50/50 flex items-center justify-end gap-3 rounded-b-[12px] shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-[13px] font-semibold text-gh-textBase bg-white border border-gh-border hover:bg-gray-50 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200"
          >
            Cancel
          </button>
          {mode === "form" ? (
            <button
              onClick={() => onSave(protectRules, targetBranch)}
              disabled={isSaving || !canSaveForm}
              className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50"
            >
              {isSaving ? "Saving..." : isTemplateMode ? "Save Rules" : "Apply Protection"}
            </button>
          ) : (
            <button
              onClick={handleApplyJson}
              disabled={isSaving || !jsonText.trim()}
              className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-blue hover:bg-gh-blueHover rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gh-blue/30 active:scale-[0.98] disabled:opacity-50"
            >
              {isSaving ? "Saving..." : isTemplateMode ? "Save JSON to Template" : "Apply JSON to GitHub"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}