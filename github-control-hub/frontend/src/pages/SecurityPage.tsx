import React, { useState } from "react";
import { useAlerts, useResolveAlert, useUnresolveAlert, useSimulateAlert, useInactiveUsers } from "../hooks/useAlerts";
import { SecurityAlert } from "../types/Alert";
import Navbar from "../components/Navbar";
import { useAuth } from "../App";

const SEVERITY_CONFIG: Record<string, { color: string; icon: string; bg: string }> = {
  critical: { color: "text-red-600", bg: "bg-red-50", icon: "ph-fill ph-warning-octagon" },
  high: { color: "text-orange-600", bg: "bg-orange-50", icon: "ph-fill ph-warning" },
  medium: { color: "text-yellow-600", bg: "bg-yellow-50", icon: "ph-fill ph-info" },
  low: { color: "text-blue-600", bg: "bg-blue-50", icon: "ph-fill ph-info" },
};

const TYPE_LABELS: Record<string, string> = {
  protection_removed: "Protection Removed",
  ruleset_disabled: "Ruleset Disabled",
  repo_made_public: "Repository Made Public",
  admin_added: "Admin/Outside Access Granted",
  protection_drift: "Protection Drift Detected",
  user_promoted: "User Promoted to Admin",
  team_elevated: "Team Permissions Elevated",
  team_added: "Team Added to Repo",
  team_removed: "Team Removed from Repo",
  team_permission_changed: "Team Permission Changed",
  suspicious_activity: "Suspicious Activity",
};

export default function SecurityPage() {
  const { data: alerts, isLoading: alertsLoading } = useAlerts();
  const { data: inactiveUsers, isLoading: usersLoading } = useInactiveUsers();
  const resolveMutation = useResolveAlert();
  const unresolveMutation = useUnresolveAlert();
  const simulateMutation = useSimulateAlert();
  const [filter, setFilter] = useState<"all" | "active" | "resolved">("active");
  const [isSimulating, setIsSimulating] = useState(false);
  const { user } = useAuth();

  const isLoading = alertsLoading || usersLoading;

  if (isLoading) {
    return (
      <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
        <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
        <div className="p-8 flex justify-center">
          <div className="animate-spin w-8 h-8 border-4 border-gh-blue border-t-transparent rounded-full"></div>
        </div>
      </div>
    );
  }

  const filteredAlerts = (alerts || []).filter((alert) => {
    if (filter === "active") return !alert.resolved;
    if (filter === "resolved") return alert.resolved;
    return true;
  });

  const handleResolve = (id: string) => {
    resolveMutation.mutate(id);
  };

  const handleUnresolve = (id: string) => {
    unresolveMutation.mutate(id);
  };

  return (
    <div className="bg-gh-bg text-gh-textBase min-h-screen pt-14">
      <Navbar login={user?.login} avatarUrl={user?.avatarUrl} />
      <main className="max-w-6xl mx-auto p-4 sm:p-8 animate-fade-in">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl font-bold text-gh-textBase flex items-center gap-2">
              <i className="ph-fill ph-shield-warning text-gh-textMuted"></i>
              Security Alerts
            </h1>
            <p className="text-gh-muted text-sm mt-1">
              Detect and respond to dangerous actions and protection drift across your organization.
            </p>
          </div>
          
          <div className="flex items-center gap-2 relative">
            <button
              onClick={() => setIsSimulating(!isSimulating)}
              className="px-4 py-2 text-[13px] font-semibold text-white bg-gh-dark hover:bg-black rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200 flex items-center gap-2"
            >
              <i className="ph-bold ph-lightning"></i>
              Attack Simulator
              <i className={`ph-bold ph-caret-down text-[10px] ml-1 transition-transform ${isSimulating ? "rotate-180" : ""}`}></i>
            </button>
            
            {isSimulating && (
              <div className="absolute top-full right-0 mt-2 w-64 bg-white border border-gh-border rounded-xl shadow-lg z-50 overflow-hidden text-left">
                <div className="px-3 py-2 bg-gray-50 border-b border-gh-border font-semibold text-xs text-gh-textMuted uppercase tracking-wider">
                  Simulate Scenarios
                </div>
                <div className="p-1 flex flex-col">
                  {[
                    { id: "compromised_dev", icon: "ph-user-focus", label: "Compromised Developer", desc: "Push to 40 repos in 5m" },
                    { id: "malicious_pr", icon: "ph-git-pull-request", label: "Malicious PR", desc: "Bypass protections" },
                    { id: "force_push", icon: "ph-git-commit", label: "Force Push", desc: "Overwrite main history" },
                    { id: "privilege_escalation", icon: "ph-key", label: "Privilege Escalation", desc: "User promoted to admin" },
                  ].map(scenario => (
                    <button
                      key={scenario.id}
                      onClick={() => {
                        simulateMutation.mutate(scenario.id);
                        setIsSimulating(false);
                      }}
                      className="text-left px-3 py-2.5 hover:bg-gray-50 rounded-lg group transition-colors flex items-start gap-3"
                    >
                      <i className={`ph ${scenario.icon} text-gh-muted group-hover:text-gh-blue mt-0.5`}></i>
                      <div>
                        <div className="text-sm font-semibold text-gh-textBase group-hover:text-gh-blue">{scenario.label}</div>
                        <div className="text-xs text-gh-muted">{scenario.desc}</div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          
          {/* Main Alerts List */}
          <div className="lg:col-span-2 space-y-6">
            {/* Filters */}
            <div className="flex gap-2 border-b border-gh-border pb-4">
        {["active", "resolved", "all"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f as any)}
            className={`px-4 py-1.5 text-sm font-semibold rounded-full capitalize transition-colors ${
              filter === f
                ? "bg-gh-blue text-white"
                : "bg-white border border-gh-border text-gh-textMuted hover:text-gh-textBase"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Alerts List */}
      <div className="space-y-4">
        {filteredAlerts.length === 0 ? (
          <div className="bg-white rounded-[12px] border border-gh-border p-12 text-center">
            <div className="w-16 h-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="ph-fill ph-check-circle text-3xl text-green-500"></i>
            </div>
            <h3 className="text-lg font-semibold text-gh-textBase">No {filter} alerts</h3>
            <p className="text-gh-muted mt-1">Your organization is secure.</p>
          </div>
        ) : (
          filteredAlerts.map((alert) => (
            <div
              key={alert.id}
              className={`bg-white rounded-[12px] border ${
                alert.resolved ? "border-gray-200 opacity-75" : "border-gh-border shadow-sm"
              } p-5 flex flex-col sm:flex-row gap-4 sm:items-center justify-between transition-all`}
            >
              <div className="flex gap-4 items-start">
                <div className={`mt-1 w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${SEVERITY_CONFIG[alert.severity].bg}`}>
                  <i className={`text-xl ${SEVERITY_CONFIG[alert.severity].icon} ${SEVERITY_CONFIG[alert.severity].color}`}></i>
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-bold text-gh-textBase">{alert.repo}</span>
                    <span className="text-gh-muted text-sm">•</span>
                    <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${alert.resolved ? 'bg-gray-100 text-gray-600 border-gray-200' : 'bg-red-50 text-red-600 border-red-100'}`}>
                      {TYPE_LABELS[alert.type] || alert.type}
                    </span>
                    <span className="text-xs text-gh-muted ml-2">
                      {new Date(alert.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className={`text-sm ${alert.resolved ? "text-gh-muted line-through" : "text-gh-textBase"}`}>
                    {alert.message}
                  </p>
                  
                  {alert.details && !alert.resolved && (
                    <div className="mt-3 bg-gray-50 border border-gray-200 rounded-md p-3 text-xs font-mono text-gh-muted">
                      {JSON.stringify(alert.details, null, 2)}
                    </div>
                  )}

                  {alert.resolved && alert.resolvedBy && (
                    <p className="text-xs text-gh-muted mt-2">
                      Resolved by <span className="font-semibold">{alert.resolvedBy}</span> on {new Date(alert.resolvedAt!).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex shrink-0">
                {!alert.resolved ? (
                  <button
                    onClick={() => handleResolve(alert.id)}
                    disabled={resolveMutation.isPending}
                    className="px-4 py-2 text-[13px] font-semibold text-gh-textBase bg-white border border-gh-border hover:bg-gray-50 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200 disabled:opacity-50 flex items-center gap-2"
                  >
                    <i className="ph-bold ph-check text-green-600"></i>
                    Acknowledge & Resolve
                  </button>
                ) : (
                  <button
                    onClick={() => handleUnresolve(alert.id)}
                    disabled={unresolveMutation.isPending}
                    className="px-4 py-2 text-[13px] font-semibold text-gh-muted bg-white border border-gh-border hover:bg-gray-50 rounded-[6px] shadow-sm transition-colors outline-none focus:ring-4 focus:ring-gray-200 disabled:opacity-50 flex items-center gap-2"
                  >
                    <i className="ph-bold ph-arrow-u-up-left"></i>
                    Unresolve
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      </div>

      {/* Sidebar: Inactive Users */}
      <div className="lg:col-span-1">
        <div className="bg-white rounded-xl border border-gh-border shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b border-gh-border flex items-center gap-2">
            <i className="ph-fill ph-users text-gh-muted"></i>
            <h3 className="font-bold text-gh-textBase text-sm">Inactive Users (180+ Days)</h3>
          </div>
          <div className="p-0">
            {(!inactiveUsers || inactiveUsers.length === 0) ? (
              <div className="p-6 text-center text-sm text-gh-muted">
                No inactive users found.
              </div>
            ) : (
              <ul className="divide-y divide-gray-100">
                {inactiveUsers.map(u => (
                  <li key={u.username} className="px-4 py-3 hover:bg-gray-50 flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-gh-textBase">{u.username}</span>
                        <span className="text-[10px] uppercase font-bold text-gh-muted bg-gray-100 px-1.5 py-0.5 rounded border border-gray-200">
                          {u.role}
                        </span>
                      </div>
                      <div className="text-xs text-gh-muted mt-1">
                        Last active: {new Date(u.lastActive).toLocaleDateString()}
                      </div>
                    </div>
                    <button className="text-xs font-semibold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2 py-1 rounded border border-red-100 transition-colors">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-4 py-2 bg-gray-50 border-t border-gh-border text-xs text-gh-muted">
            Old accounts are security risks. Review and remove.
          </div>
        </div>
      </div>
      
      </div>
      </main>
    </div>
  );
}
