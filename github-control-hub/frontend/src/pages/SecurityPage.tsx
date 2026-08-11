import { useState, useMemo } from "react";
import { useAlerts, useResolveAlert, useUnresolveAlert, useInactiveUsers } from "../hooks/useAlerts";
import { useAuth } from "../App";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, Sheet, Block,
  RailCard, Note, Pill, Empty, Spinner, TYPE, INTENT, enter, type Intent,
} from "../design";

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

const ALERTS_PER_PAGE = 10;

export default function SecurityPage() {
  const { user } = useAuth();
  const { data: alerts, isLoading: alertsLoading } = useAlerts();
  const { data: inactiveUsers, isLoading: usersLoading } = useInactiveUsers();
  const resolve = useResolveAlert();
  const unresolve = useUnresolveAlert();

  const [filter, setFilter] = useState<"active" | "resolved" | "all">("active");
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const a = alerts ?? [];
    return {
      active: a.filter(x => !x.resolved).length,
      resolved: a.filter(x => x.resolved).length,
      all: a.length,
      critical: a.filter(x => !x.resolved && (x.severity === "critical" || x.severity === "high")).length,
      stale: inactiveUsers?.length ?? 0,
    };
  }, [alerts, inactiveUsers]);

  const filtered = useMemo(() => (alerts ?? []).filter(a =>
    filter === "active" ? !a.resolved : filter === "resolved" ? a.resolved : true
  ), [alerts, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / ALERTS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * ALERTS_PER_PAGE, safePage * ALERTS_PER_PAGE);

  if (alertsLoading || usersLoading) {
    return <Page user={user}><Spinner /></Page>;
  }

  const clean = counts.active === 0;
  const resolvedPct = counts.all ? Math.round((counts.resolved / counts.all) * 100) : 100;

  return (
    <Page user={user}>
      <PageHeader
        title="Security"
        subtitle="Events detected across the organization, and accounts that have gone quiet."
      />

      <StatusSlab
        intent={clean ? "good" : counts.critical > 0 ? "danger" : "warn"}
        eyebrow={clean ? "Nothing outstanding" : counts.critical > 0 ? "Urgent attention" : "Needs review"}
        metrics={[
          { value: counts.active, label: "open alerts", emphasis: true },
          { value: counts.critical, label: "high or critical" },
          { value: counts.stale, label: "stale accounts" },
        ]}
        aside={<SlabPercent value={resolvedPct} label="resolved" />}
        footer={
          clean
            ? <>{counts.resolved} alerts resolved to date</>
            : <>{counts.active} of {counts.all} alerts still open</>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-6 items-start">
        <div>
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <Segmented value={filter} onChange={(f) => { setFilter(f); setPage(1); }} options={[
              ["active", `Open ${counts.active}`],
              ["resolved", `Resolved ${counts.resolved}`],
              ["all", `All ${counts.all}`],
            ]} />
            {totalPages > 1 && (
              <div className="flex items-center gap-2 text-sm">
                <Button variant="ghost" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>
                  <i className="ph-bold ph-caret-left"></i>
                </Button>
                <span className="text-slate-500 dark:text-slate-400 tabular-nums font-semibold">
                  {safePage} / {totalPages}
                </span>
                <Button variant="ghost" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>
                  <i className="ph-bold ph-caret-right"></i>
                </Button>
              </div>
            )}
          </div>

          {shown.length === 0 ? (
            <Empty
              title={filter === "active" ? "Nothing open" : `No ${filter} alerts`}
              body={filter === "active"
                ? "Every alert raised so far has been dealt with."
                : "Alerts appear here as GitHub reports events for the organization."}
            />
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
                          <pre className="mt-3 p-3 rounded-xl bg-slate-50 dark:bg-slate-800 text-[11px] font-mono text-slate-500 dark:text-slate-400 max-h-32 overflow-auto">
                            {JSON.stringify(a.details, null, 2)}
                          </pre>
                        )}
                      </div>
                      <div className="shrink-0">
                        {a.resolved ? (
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
        </div>

        {/* Stale accounts */}
        <div className="lg:sticky lg:top-20">
          <Sheet>
            <div className={`px-6 py-5 ${INTENT[counts.stale > 0 ? "warn" : "neutral"].solid}`}>
              <p className={`${TYPE.label} text-white/60`}>Dormant 180+ days</p>
              <p className="text-[40px] font-black text-white leading-none tabular-nums mt-2">{counts.stale}</p>
              <p className="text-sm text-white/70 mt-1.5">
                {counts.stale === 0 ? "No stale accounts" : counts.stale === 1 ? "account still has access" : "accounts still have access"}
              </p>
            </div>
            {!inactiveUsers?.length ? (
              <Block title="Accounts">
                <p className="text-sm text-slate-500 dark:text-slate-400">Everyone with access has been active recently.</p>
              </Block>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[460px] overflow-y-auto">
                {inactiveUsers.map((u, i) => (
                  <li key={u.username} style={enter(i, 30, 240)}
                    className="px-6 py-3.5 flex items-center justify-between gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate flex items-center gap-1.5">
                        {u.username}
                        {u.role === "admin" && <i className="ph-fill ph-shield-star text-amber-500 text-xs" title="Organization admin"></i>}
                      </p>
                      <p className="text-[12px] text-slate-400 dark:text-slate-500 mt-0.5">
                        {u.role} · last active {new Date(u.lastActive).toLocaleDateString(undefined, { month: "short", year: "numeric" })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Sheet>
          <div className="mt-3">
            <Note intent="info">
              Dormant accounts keep their access. Each one is a way in that nobody is watching.
            </Note>
          </div>
        </div>
      </div>
    </Page>
  );
}
