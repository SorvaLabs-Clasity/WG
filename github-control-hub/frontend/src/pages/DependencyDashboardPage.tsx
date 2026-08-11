import { useState, useMemo } from "react";
import { useDependencies, useDependencySummary, useEnableDependabot, useDisableDependabot } from "../hooks/useDependencies";
import { useAuth } from "../App";
import type { DependencyAlert } from "../types/Dependabot";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, SearchInput,
  RailCard, Note, Chip, Pill, Empty, Spinner, TYPE, enter, type Intent,
} from "../design";

/** Severity maps onto the shared intents so colour means one thing app-wide. */
const SEVERITY: Record<string, Intent> = {
  critical: "danger", high: "danger", medium: "warn", low: "info",
};

const REPOS_PER_PAGE = 15;

export default function DependencyDashboardPage() {
  const { user } = useAuth();
  const { data: dependencies, isLoading: depsLoading, isError: depsError, error: depsErrorObj } = useDependencies();
  const { data: summary, isLoading: sumLoading } = useDependencySummary();
  const enable = useEnableDependabot();
  const disable = useDisableDependabot();

  const [filter, setFilter] = useState<"alerts" | "critical" | "high" | "off" | "all">("alerts");
  const [search, setSearch] = useState("");
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matching = (dependencies ?? []).filter(d => {
      if (q && !d.repo.toLowerCase().includes(q)) return false;
      switch (filter) {
        case "all": return true;
        case "off": return !!d.disabled;
        case "critical": return !d.disabled && !d.clean && d.severity === "critical";
        case "high": return !d.disabled && !d.clean && (d.severity === "critical" || d.severity === "high");
        default: return !d.disabled && !d.clean;
      }
    });
    const by = new Map<string, DependencyAlert[]>();
    matching.forEach(d => by.set(d.repo, [...(by.get(d.repo) ?? []), d]));
    // Worst first — a repo with criticals should never be below a clean one.
    return [...by.entries()].sort((a, b) => {
      const sev = (xs: DependencyAlert[]) => xs.filter(x => x.severity === "critical").length * 1000 + xs.length;
      return sev(b[1]) - sev(a[1]) || a[0].localeCompare(b[0]);
    });
  }, [dependencies, search, filter]);

  const counts = useMemo(() => {
    const all = dependencies ?? [];
    const off = new Set(all.filter(d => d.disabled).map(d => d.repo)).size;
    const clean = new Set(all.filter(d => d.clean).map(d => d.repo)).size;
    const vulnerable = new Set(all.filter(d => !d.clean && !d.disabled).map(d => d.repo)).size;
    const repos = off + clean + vulnerable;
    return {
      off, clean, vulnerable, repos,
      critical: summary?.critical ?? 0,
      high: summary?.high ?? 0,
      total: (summary?.critical ?? 0) + (summary?.high ?? 0) + (summary?.medium ?? 0) + (summary?.low ?? 0),
      pct: repos ? Math.round((clean / repos) * 100) : 100,
    };
  }, [dependencies, summary]);

  if (depsLoading || sumLoading) return <Page user={user}><Spinner /></Page>;

  const rateLimited = depsError && (depsErrorObj as any)?.message?.includes("429");
  const totalPages = Math.max(1, Math.ceil(groups.length / REPOS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const shown = groups.slice((safePage - 1) * REPOS_PER_PAGE, safePage * REPOS_PER_PAGE);

  return (
    <Page user={user}>
      <PageHeader
        title="Dependabot"
        subtitle="Known vulnerabilities in dependencies, and which repositories are watching for them."
      />

      <StatusSlab
        intent={counts.critical > 0 ? "danger" : counts.total > 0 ? "warn" : "good"}
        eyebrow={counts.critical > 0 ? "Critical vulnerabilities" : counts.total > 0 ? "Vulnerabilities open" : "Nothing outstanding"}
        metrics={[
          { value: counts.critical, label: "critical", emphasis: true },
          { value: counts.high, label: "high" },
          { value: counts.vulnerable, label: "repos affected" },
        ]}
        aside={<SlabPercent value={counts.pct} label="repos clean" />}
        footer={
          counts.off > 0
            ? <><strong className="font-bold">{counts.off}</strong> {counts.off === 1 ? "repository has" : "repositories have"} Dependabot switched off — nothing is being detected there</>
            : <>{counts.total} open alerts across {counts.repos} repositories</>
        }
      />

      {rateLimited && (
        <Note intent="warn">
          GitHub rate-limited the alert fetch. Counts may be incomplete until the limit resets.
        </Note>
      )}

      <div className="flex items-center gap-3 flex-wrap mb-5">
        <SearchInput value={search} onChange={v => { setSearch(v); setPage(1); }} placeholder="Search repositories" />
        <Segmented value={filter} onChange={f => { setFilter(f); setPage(1); }} options={[
          ["alerts", "With alerts"],
          ["critical", `Critical ${counts.critical}`],
          ["high", "Critical + high"],
          ["off", `Not watching ${counts.off}`],
          ["all", "All"],
        ]} />
        {totalPages > 1 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Button variant="ghost" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>
              <i className="ph-bold ph-caret-left"></i>
            </Button>
            <span className="text-slate-500 dark:text-slate-400 tabular-nums font-semibold">{safePage} / {totalPages}</span>
            <Button variant="ghost" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>
              <i className="ph-bold ph-caret-right"></i>
            </Button>
          </div>
        )}
      </div>

      {shown.length === 0 ? (
        <Empty
          title={filter === "off" ? "Every repository is watching" : "Nothing to show"}
          body={filter === "off"
            ? "Dependabot alerts are enabled everywhere."
            : "No repositories match this filter."}
        />
      ) : (
        <div className="grid gap-3">
          {shown.map(([repo, alerts], i) => {
            const off = alerts.some(a => a.disabled);
            const clean = !off && alerts.every(a => a.clean);
            const critical = alerts.filter(a => a.severity === "critical").length;
            const real = alerts.filter(a => !a.clean && !a.disabled);
            const intent: Intent = off ? "neutral" : critical > 0 ? "danger" : real.length > 0 ? "warn" : "good";

            return (
              <RailCard key={repo} intent={intent} index={i}>
                <div className="flex items-start justify-between gap-5 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>{repo}</h3>
                      {off && <Pill intent="neutral">not watching</Pill>}
                      {clean && <Pill intent="good">clean</Pill>}
                      {critical > 0 && <Pill intent="danger">{critical} critical</Pill>}
                    </div>

                    {off ? (
                      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1.5`}>
                        Dependabot is switched off, so vulnerabilities here go undetected.
                      </p>
                    ) : clean ? (
                      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1.5`}>
                        No known vulnerabilities.
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-1.5">
                        {real.slice(0, 6).map(a => (
                          <li key={a.id} className="flex items-baseline gap-2.5 flex-wrap">
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 translate-y-[-1px] ${
                              a.severity === "critical" ? "bg-rose-500"
                                : a.severity === "high" ? "bg-orange-500"
                                  : a.severity === "medium" ? "bg-amber-500" : "bg-blue-500"}`} />
                            <span className={`${TYPE.mono} font-medium text-slate-800 dark:text-slate-100`}>{a.dependency}</span>
                            <span className="text-[12px] text-slate-400 dark:text-slate-500">{a.ecosystem}</span>
                            <Chip intent={SEVERITY[a.severity] ?? "info"}>{a.cve}</Chip>
                            <span className="text-[12px] text-slate-500 dark:text-slate-400">
                              {a.patched_version ? <>fixed in {a.patched_version}</> : "no fix available"}
                            </span>
                          </li>
                        ))}
                        {real.length > 6 && (
                          <li className="text-[12px] text-slate-400 dark:text-slate-500 pl-4">
                            and {real.length - 6} more
                          </li>
                        )}
                      </ul>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-4">
                    {!off && !clean && (
                      <div className="text-right">
                        <p className={`${TYPE.metricSm} ${critical > 0 ? "text-rose-600 dark:text-rose-400" : "text-amber-600 dark:text-amber-400"}`}>
                          {real.length}
                        </p>
                        <p className="text-[11px] uppercase tracking-wider font-bold text-slate-400 mt-1">alerts</p>
                      </div>
                    )}
                    {off ? (
                      <Button variant="primary" disabled={busyRepo === repo}
                        onClick={async () => { setBusyRepo(repo); try { await enable.mutateAsync(repo); } finally { setBusyRepo(null); } }}>
                        {busyRepo === repo ? "Enabling…" : "Start watching"}
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busyRepo === repo}
                        onClick={async () => {
                          if (!window.confirm(`Stop watching ${repo} for vulnerable dependencies?`)) return;
                          setBusyRepo(repo);
                          try { await disable.mutateAsync(repo); } finally { setBusyRepo(null); }
                        }}>
                        {busyRepo === repo ? "…" : "Stop watching"}
                      </Button>
                    )}
                  </div>
                </div>
              </RailCard>
            );
          })}
        </div>
      )}
    </Page>
  );
}
