import { useState, useMemo } from "react";
import { useAlerts, useResolveAlert, useUnresolveAlert } from "../hooks/useAlerts";
import { usePermissions } from "../hooks/usePermissions";
import { useAuth } from "../App";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, Sheet, Block,
  RailCard, Note, Pill, Empty, Spinner, Figure, TYPE, INTENT, enter, type Intent, RefreshButton,
  SearchInput, Pager,
} from "../design";
import { useTableControls } from "../hooks/useTableControls";
import SecurityAlertPanel from "../components/SecurityAlertPanel";

const TYPE_LABELS: Record<string, string> = {
  protection_removed: "Protection removed",
  ruleset_disabled: "Ruleset disabled",
  repo_made_public: "Repository made public",
  admin_added: "Admin access granted",
  protection_drift: "Protection drift",
  user_promoted: "User promoted to admin",
  team_elevated: "Team permissions elevated",
  team_added: "Team added to repo",
  team_removed: "Team removed from repo",
  team_permission_changed: "Team permission changed",
  suspicious_activity: "Suspicious activity",
};

/** Severity maps onto the shared intents so colour means the same thing everywhere. */
const SEVERITY: Record<string, Intent> = {
  critical: "danger", high: "danger", medium: "warn", low: "info",
};

/** Sorting severity alphabetically puts "critical" under "high". Rank it. */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const ALERTS_PER_PAGE = 10;

export default function SecurityPage() {
  const { user } = useAuth();
  const { data: alerts, isLoading: alertsLoading, isFetching: alertsFetching, refetch: refetchAlerts } = useAlerts();
  // Resolving is the org's record that a finding was dealt with, so it is
  // gated like the rest of the shared state. The server enforces it.
  const { data: permissions } = usePermissions();
  const canResolve = permissions?.isControlHubAdmin ?? false;

  const resolve = useResolveAlert();
  const unresolve = useUnresolveAlert();

  const [filter, setFilter] = useState<"active" | "resolved" | "all">("active");

  const counts = useMemo(() => {
    const a = alerts ?? [];
    return {
      active: a.filter(x => !x.resolved).length,
      resolved: a.filter(x => x.resolved).length,
      all: a.length,
      critical: a.filter(x => !x.resolved && (x.severity === "critical" || x.severity === "high")).length,
    };
  }, [alerts]);

  const filtered = useMemo(() => (alerts ?? []).filter(a =>
    filter === "active" ? !a.resolved : filter === "resolved" ? a.resolved : true
  ), [alerts, filter]);

  // Search covers what someone would actually type looking for an alert: the
  // repository, the human-readable alert type, its message and its severity.
  const table = useTableControls(filtered, {
    searchText: a => `${a.repo} ${TYPE_LABELS[a.type] ?? a.type} ${a.message ?? ""} ${a.severity}`,
    columns: [
      { key: "repo", label: "Repository", value: a => a.repo },
      { key: "severity", label: "Severity", value: a => SEVERITY_ORDER[a.severity] ?? 99 },
      { key: "created", label: "Raised", value: a => a.timestamp ?? "" },
    ],
    perPage: ALERTS_PER_PAGE,
  });
  const shown = table.visible;

  if (alertsLoading) {
    return <Page user={user}><Spinner /></Page>;
  }

  const clean = counts.active === 0;
  const resolvedPct = counts.all ? Math.round((counts.resolved / counts.all) * 100) : 100;

  return (
    <Page user={user}>
      <PageHeader
        title="Security"
        subtitle="Events detected across the organization, and accounts that have gone quiet."
        actions={<RefreshButton busy={alertsFetching} onRefresh={() => refetchAlerts()} />}
      />

      <StatusSlab
        intent={clean ? "good" : counts.critical > 0 ? "danger" : "warn"}
        eyebrow={clean ? "Nothing outstanding" : counts.critical > 0 ? "Urgent attention" : "Needs review"}
        metrics={[
          { value: counts.active, label: "open alerts", emphasis: true },
          { value: counts.critical, label: "high or critical" },
        ]}
        aside={<SlabPercent value={resolvedPct} label="resolved" />}
        footer={
          clean
            ? <>{counts.resolved} alerts resolved to date</>
            : <>{counts.active} of {counts.all} alerts still open</>
        }
      />

      <div>
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <Segmented value={filter} onChange={setFilter} options={[
              ["active", `Open ${counts.active}`],
              ["resolved", `Resolved ${counts.resolved}`],
              ["all", `All ${counts.all}`],
            ]} />
            <div className="flex items-center gap-2 flex-wrap">
              <SearchInput value={table.search} onChange={table.setSearch} placeholder="Search alerts…" />
              <Segmented value={table.sortKey ?? "severity"} onChange={table.toggleSort} options={[
                ["severity", "Severity"],
                ["repo", "Repository"],
                ["created", "Raised"],
              ]} />
            </div>
          </div>

          {shown.length === 0 ? (
            table.filtered ? (
              <Empty
                title="No alerts match that search"
                body={`Nothing in ${table.totalCount} ${filter === "all" ? "" : filter + " "}alerts matches "${table.search.trim()}".`}
              />
            ) : (
              <Empty
                title={filter === "active" ? "Nothing open" : `No ${filter} alerts`}
                body={filter === "active"
                  ? "Every alert raised so far has been dealt with."
                  : "Alerts appear here as GitHub reports events for the organization."}
              />
            )
          ) : (
            <div className="grid gap-3">
              {shown.map((a, i) => {
                const intent: Intent = a.resolved ? "neutral" : SEVERITY[a.severity] ?? "info";
                return (
                  <RailCard key={a.id} intent={intent} index={i}>
                    <div className="flex items-start justify-between gap-5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className={`${TYPE.heading} ${a.resolved ? "text-slate-400 dark:text-slate-500" : "text-slate-900 dark:text-white"}`}>
                            {a.repo}
                          </h3>
                          <Pill intent={a.resolved ? "neutral" : intent}>
                            {TYPE_LABELS[a.type] ?? a.type}
                          </Pill>
                        </div>
                        <p className={`${TYPE.sub} mt-1.5 ${a.resolved ? "text-slate-400 dark:text-slate-500" : "text-slate-600 dark:text-slate-300"}`}>
                          {a.message}
                        </p>
                        <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-2">
                          {new Date(a.timestamp).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                          {a.resolved && a.resolvedBy && <> · resolved by <span className="font-semibold">{a.resolvedBy}</span></>}
                        </p>
                        {a.details && !a.resolved && (
                          <pre className="mt-3 p-3 rounded-xl bg-slate-50 dark:bg-white/[0.05] text-[11px] font-mono text-slate-500 dark:text-slate-300 max-h-32 overflow-auto">
                            {JSON.stringify(a.details, null, 2)}
                          </pre>
                        )}
                      </div>
                      <div className="shrink-0">
                        {!canResolve ? null : a.resolved ? (
                          <Button variant="secondary" disabled={unresolve.isPending} onClick={() => unresolve.mutate(a.id)}>
                            Reopen
                          </Button>
                        ) : (
                          <Button variant="primary" disabled={resolve.isPending} onClick={() => resolve.mutate(a.id)}>
                            Resolve
                          </Button>
                        )}
                      </div>
                    </div>
                  </RailCard>
                );
              })}
            </div>
          )}

          <Pager
            page={table.page} totalPages={table.totalPages} onPage={table.setPage}
            matchCount={table.matchCount} totalCount={table.totalCount}
            filtered={table.filtered} noun="alerts"
          />
        </div>

        {/* Who hears about these, and how quickly. Placed under the alerts
            rather than in a settings screen, because the question "should
            somebody be emailed about this?" arrives while looking at one. */}
        <div className="mt-10">
          <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-1">Notifications</h2>
          <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
            Email delivery for the alerts above. Groups are created on the Alarms page.
          </p>
          <SecurityAlertPanel isAdmin={permissions?.isAwsAdmin ?? false} />
        </div>

    </Page>
  );
}
