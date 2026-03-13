import { useState, useMemo } from "react";
import { useOrgActors } from "../hooks/useOrgConfig";

export type BypassActor = {
  actor_id: number;
  actor_type: "RepositoryRole" | "Team" | "Integration" | "OrganizationAdmin";
  bypass_mode: "always" | "pull_request";
};

export function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer group/chk">
      <div className="flex items-center h-5 mt-0.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4 text-gh-blue border-gray-300 dark:border-slate-600 rounded focus:ring-gh-blue focus:ring-2 focus:ring-offset-1 transition-colors"
        />
      </div>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-gh-textBase dark:text-slate-200 group-hover/chk:text-gh-blue transition-colors">{label}</span>
        <span className="text-[11px] text-gh-muted dark:text-slate-400 leading-snug">{desc}</span>
      </div>
    </label>
  );
}

export function Section({ title, icon, children, defaultOpen = false }: { title: string; icon: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="group/section border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden" open={defaultOpen}>
      <summary className="px-4 py-3 bg-gray-50 dark:bg-slate-800 cursor-pointer hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors list-none flex items-center gap-2 select-none">
        <i className={"ph-bold ph-caret-right text-xs text-gray-400 dark:text-slate-500 group-open/section:rotate-90 transition-transform"}></i>
        <i className={icon + " text-gray-500 dark:text-slate-400 text-sm"}></i>
        <span className="text-sm font-semibold text-gh-textBase dark:text-slate-200">{title}</span>
      </summary>
      <div className="p-4 space-y-4 border-t border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        {children}
      </div>
    </details>
  );
}

export function ActorRow({
  icon,
  name,
  desc,
  selected,
  onToggle,
  mode,
  onModeChange,
  hideBypassMode = false,
}: {
  icon: string;
  name: string;
  desc: string;
  selected: boolean;
  onToggle: () => void;
  mode: "always" | "pull_request";
  onModeChange: (m: "always" | "pull_request") => void;
  hideBypassMode?: boolean;
}) {
  return (
    <div className={"flex items-center gap-3 px-3 py-2 border-b border-gray-50 dark:border-slate-800 last:border-0 hover:bg-gray-50/50 dark:hover:bg-slate-800/50 transition-colors " + (selected ? "bg-blue-50/30 dark:bg-blue-950/30" : "")}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        className="w-4 h-4 text-gh-blue border-gray-300 dark:border-slate-600 rounded focus:ring-gh-blue shrink-0"
      />
      <i className={icon + " text-gray-500 dark:text-slate-400 text-sm shrink-0"}></i>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-gh-textBase dark:text-slate-200">{name}</span>
        <span className="text-[11px] text-gh-muted dark:text-slate-400 ml-2">{desc}</span>
      </div>
      {selected && !hideBypassMode && (
        <select
          value={mode}
          onChange={e => onModeChange(e.target.value as "always" | "pull_request")}
          className="text-[11px] px-2 py-1 border border-gray-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-gh-textBase dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-gh-blue shrink-0"
        >
          <option value="always">Always</option>
          <option value="pull_request">PRs only</option>
        </select>
      )}
    </div>
  );
}

export function BypassActorsSection({
  enforceAdmins,
  onEnforceAdminsChange,
  bypassActors,
  onBypassActorsChange,
  hideBypassMode = false,
  requireWritePermission = false,
}: {
  enforceAdmins: boolean;
  onEnforceAdminsChange: (v: boolean) => void;
  bypassActors: BypassActor[];
  onBypassActorsChange: (v: BypassActor[]) => void;
  /** When true, hides the per-actor bypass mode dropdown (tag rulesets only support "always") */
  hideBypassMode?: boolean;
  /** When true, filters roles to only those with write+ base permissions (for tag rulesets) */
  requireWritePermission?: boolean;
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
    let roles = actors.roles;
    if (requireWritePermission) {
      roles = roles.filter(r => r.has_write !== false);
    }
    return roles.filter(r => r.name.toLowerCase().includes(search.toLowerCase()));
  }, [actors, search, requireWritePermission]);

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
          <p className="text-[12px] text-gh-muted dark:text-slate-400">
            Select roles, teams, and apps that are allowed to bypass these rules.
          </p>
          {requireWritePermission && (
            <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
              <i className="ph-fill ph-info text-sm"></i>
              Tag rulesets require bypass actors with at least Write permissions. Roles with Read or Triage base are hidden.
            </p>
          )}

          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <i className="ph ph-magnifying-glass text-gray-400 dark:text-slate-500 text-sm"></i>
            </div>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search roles, teams, apps..."
              className="w-full pl-9 pr-3 py-2 text-[13px] border border-gray-200 dark:border-slate-700 rounded-lg bg-gray-50 dark:bg-slate-800 focus:bg-white dark:focus:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-gh-blue/20 focus:border-gh-blue transition-all dark:text-slate-200 dark:placeholder:text-slate-500"
            />
          </div>

          <div className="border border-gray-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 overflow-hidden max-h-56 overflow-y-auto">
            {!actors ? (
              <div className="px-4 py-6 text-center text-sm text-gh-muted dark:text-slate-400">
                <i className="ph ph-spinner ph-spin mr-2"></i>Loading...
              </div>
            ) : (
              <>
                {filteredRoles.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 text-[10px] font-bold text-gh-muted dark:text-slate-400 uppercase tracking-wider border-b border-gray-100 dark:border-slate-700 sticky top-0">
                      Roles
                    </div>
                    {filteredRoles.map(role => (
                      <ActorRow
                        key={"role-" + role.id}
                        icon="ph-fill ph-shield-star"
                        name={role.name}
                        desc={role.description}
                        selected={isSelected("RepositoryRole", role.id)}
                        onToggle={() => toggle("RepositoryRole", role.id)}
                        mode={getMode("RepositoryRole", role.id)}
                        onModeChange={m => setMode("RepositoryRole", role.id, m)}
                        hideBypassMode={hideBypassMode}
                      />
                    ))}
                  </div>
                )}
                {filteredTeams.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 text-[10px] font-bold text-gh-muted dark:text-slate-400 uppercase tracking-wider border-b border-gray-100 dark:border-slate-700 sticky top-0">
                      Teams
                    </div>
                    {filteredTeams.map(team => (
                      <ActorRow
                        key={"team-" + team.id}
                        icon="ph-fill ph-users-three"
                        name={team.name}
                        desc={"@" + team.slug}
                        selected={isSelected("Team", team.id)}
                        onToggle={() => toggle("Team", team.id)}
                        mode={getMode("Team", team.id)}
                        onModeChange={m => setMode("Team", team.id, m)}
                        hideBypassMode={hideBypassMode}
                      />
                    ))}
                  </div>
                )}
                {filteredApps.length > 0 && (
                  <div>
                    <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 text-[10px] font-bold text-gh-muted dark:text-slate-400 uppercase tracking-wider border-b border-gray-100 dark:border-slate-700 sticky top-0">
                      Apps
                    </div>
                    {filteredApps.map(app => (
                      <ActorRow
                        key={"app-" + app.id}
                        icon="ph-fill ph-plugs-connected"
                        name={app.name}
                        desc={"App ID: " + app.id}
                        selected={isSelected("Integration", app.id)}
                        onToggle={() => toggle("Integration", app.id)}
                        mode={getMode("Integration", app.id)}
                        onModeChange={m => setMode("Integration", app.id, m)}
                        hideBypassMode={hideBypassMode}
                      />
                    ))}
                  </div>
                )}
                {filteredRoles.length === 0 && filteredTeams.length === 0 && filteredApps.length === 0 && (
                  <div className="px-4 py-6 text-center text-sm text-gh-muted dark:text-slate-400">
                    {search ? "No matches found" : "No actors available"}
                  </div>
                )}
              </>
            )}
          </div>

          {bypassActors.length > 0 && (
            <div className="text-[11px] text-gh-muted dark:text-slate-400">
              {bypassActors.length} bypass actor{bypassActors.length !== 1 ? "s" : ""} selected
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
