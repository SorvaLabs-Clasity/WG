import { useState, useMemo } from "react";
import { useDependencies, useDependencySummary, useEnableDependabot, useDisableDependabot } from "../hooks/useDependencies";
import { useAuth } from "../App";
import type { DependencyAlert } from "../types/Dependabot";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, SearchInput,
  RailCard, Note, Pill, Empty, Spinner, Figure, TYPE, INTENT, enter, type Intent,
} from "../design";

/** Severity maps onto the shared intents so colour means one thing app-wide. */
const SEVERITY: Record<string, Intent> = {
  critical: "danger", high: "danger", medium: "warn", low: "info",
};

/** Each severity gets its own weight so a critical never reads like a low. */
const SEV_STYLE: Record<string, { chip: string; bar: string; rank: number }> = {
  critical: { chip: "bg-rose-600 text-white", bar: "bg-rose-500", rank: 0 },
  high: { chip: "bg-orange-600 text-white", bar: "bg-orange-500", rank: 1 },
  medium: { chip: "bg-amber-500 text-white", bar: "bg-amber-400", rank: 2 },
  low: { chip: "bg-slate-400 text-white", bar: "bg-slate-300", rank: 3 },
};

const REPOS_PER_PAGE = 15;
const COLLAPSED = 4;

export default function DependencyDashboardPage() {
  const { user } = useAuth();
  const { data: dependencies, isLoading: depsLoading, isError: depsError, error: depsErrorObj } = useDependencies();
  const { data: summary, isLoading: sumLoading } = useDependencySummary();
  /**
   * Both buttons used mutateAsync with only a finally, so a rejection became an
   * unhandled promise and the click did nothing visible.
   *
   * Failures are announced by MutationErrors, which sees every mutation in the
   * app; caught here only so the rejection is handled and the busy state clears.
   */
  const [notice, setNotice] = useState<{ msg: string; ok: boolean } | null>(null);

  const runDependabot = async (repo: string, go: (r: string) => Promise<unknown>, done: string) => {
    setBusyRepo(repo);
    setNotice(null);
    try {
      await go(repo);
      setNotice({ msg: done, ok: true });
    } catch {
      /* reported globally */
    } finally {
      setBusyRepo(null);
    }
  };

  const enable = useEnableDependabot();
  const disable = useDisableDependabot();

  const [filter, setFilter] = useState<"alerts" | "critical" | "high" | "off" | "all">("alerts");
  const [search, setSearch] = useState("");
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (repo: string) =>
    setExpanded(s => {
      const next = new Set(s);
      next.has(repo) ? next.delete(repo) : next.add(repo);
      return next;
    });

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matching = (dependencies ?? []).filter(d => {
      if (q && !d.repo.toLowerCase().includes(q) && !d.dependency?.toLowerCase().includes(q)) return false;
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
    // Worst first, and severest vulnerability first within each repo.
    by.forEach(list => list.sort((a, b) =>
      (SEV_STYLE[a.severity]?.rank ?? 9) - (SEV_STYLE[b.severity]?.rank ?? 9)
      || a.dependency.localeCompare(b.dependency)));
    return [...by.entries()].sort((a, b) => {
      const w = (xs: DependencyAlert[]) => xs.filter(x => x.severity === "critical").length * 1000 + xs.length;
      return w(b[1]) - w(a[1]) || a[0].localeCompare(b[0]);
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

      {notice && (
        <div className={`mb-5 rounded-2xl border p-4 flex items-start gap-3 ${
          notice.ok ? `${INTENT.good.soft} ${INTENT.good.border}` : `${INTENT.danger.soft} ${INTENT.danger.border}`}`}>
          <i className={`${notice.ok ? "ph-fill ph-check-circle" : "ph-fill ph-warning-circle"} text-lg shrink-0 mt-0.5 ${
            notice.ok ? INTENT.good.text : INTENT.danger.text}`}></i>
          <p className={`flex-1 text-[13px] leading-relaxed ${notice.ok ? INTENT.good.text : INTENT.danger.text}`}>
            {notice.msg}
          </p>
          <button onClick={() => setNotice(null)}
            className={`shrink-0 opacity-50 hover:opacity-100 transition-opacity ${
              notice.ok ? INTENT.good.text : INTENT.danger.text}`}>
            <i className="ph-bold ph-x text-sm"></i>
          </button>
        </div>
      )}

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
        <Note intent="warn">GitHub rate-limited the alert fetch. Counts may be incomplete until the limit resets.</Note>
      )}

      <div className="flex items-center gap-3 flex-wrap mb-5">
        <SearchInput value={search} onChange={v => { setSearch(v); setPage(1); }} placeholder="Search repos or packages" />
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
          body={filter === "off" ? "Dependabot alerts are enabled everywhere." : "No repositories match this filter."}
        />
      ) : (
        <div className="grid gap-3">
          {shown.map(([repo, alerts], i) => {
            const org = alerts[0]?.org;
            const off = alerts.some(a => a.disabled);
            const clean = !off && alerts.every(a => a.clean);
            const real = alerts.filter(a => !a.clean && !a.disabled);
            const critical = real.filter(a => a.severity === "critical").length;
            const intent: Intent = off ? "neutral" : critical > 0 ? "danger" : real.length > 0 ? "warn" : "good";
            const isOpen = expanded.has(repo);
            const visible = isOpen ? real : real.slice(0, COLLAPSED);
            const hidden = real.length - visible.length;

            return (
              <RailCard key={repo} intent={intent} index={i}>
                <div className="flex items-start justify-between gap-5 flex-wrap mb-1">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>{repo}</h3>
                      {off && <Pill intent="neutral">not watching</Pill>}
                      {clean && <Pill intent="good">clean</Pill>}
                    </div>
                    {off && (
                      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>
                        Dependabot is switched off, so vulnerabilities here go undetected.
                      </p>
                    )}
                    {clean && (
                      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>No known vulnerabilities.</p>
                    )}
                  </div>

                  <div className="shrink-0 flex items-center gap-3">
                    {!off && !clean && (
                      <Figure intent={critical > 0 ? "danger" : "warn"} value={real.length}
                        label={real.length === 1 ? "alert" : "alerts"} />
                    )}
                    {org && (
                      <a href={`https://github.com/${org}/${repo}/security/dependabot`} target="_blank" rel="noreferrer"
                        className="px-3.5 py-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold text-slate-700 dark:text-slate-200 shadow-sm hover:shadow transition-shadow inline-flex items-center gap-1.5">
                        <i className="ph-fill ph-github-logo"></i>GitHub
                      </a>
                    )}
                    {off ? (
                      <Button variant="primary" disabled={busyRepo === repo}
                        onClick={() => runDependabot(repo, enable.mutateAsync, `Now watching ${repo}`)}>
                        {busyRepo === repo ? "Enabling…" : "Start watching"}
                      </Button>
                    ) : (
                      <Button variant="secondary" disabled={busyRepo === repo}
                        onClick={() => {
                          if (!window.confirm(`Stop watching ${repo} for vulnerable dependencies?`)) return;
                          runDependabot(repo, disable.mutateAsync, `Stopped watching ${repo}`);
                        }}>
                        {busyRepo === repo ? "…" : "Stop watching"}
                      </Button>
                    )}
                  </div>
                </div>

                {real.length > 0 && (
                  <>
                    <ul className="mt-3 grid gap-2">
                      {visible.map(a => <VulnRow key={a.id} alert={a} />)}
                    </ul>
                    {(hidden > 0 || isOpen) && (
                      <button onClick={() => toggle(repo)}
                        className="mt-3 text-[13px] font-bold text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-1.5">
                        <i className={`ph-bold ph-caret-${isOpen ? "up" : "down"} text-xs`}></i>
                        {isOpen
                          ? `Hide ${real.length - COLLAPSED} ${real.length - COLLAPSED === 1 ? "vulnerability" : "vulnerabilities"}`
                          : `View ${hidden} more ${hidden === 1 ? "vulnerability" : "vulnerabilities"}`}
                      </button>
                    )}
                  </>
                )}
              </RailCard>
            );
          })}
        </div>
      )}
    </Page>
  );
}

/**
 * One vulnerability.
 *
 * Given its own surface with a severity bar down the side, so a list of these
 * reads as a set of distinct findings rather than a paragraph of text. The
 * package name leads because that is what you act on; the CVE links out.
 */
function VulnRow({ alert: a }: { alert: DependencyAlert }) {
  const sev = SEV_STYLE[a.severity] ?? SEV_STYLE.low;
  return (
    <li className="relative overflow-hidden rounded-xl bg-slate-50 dark:bg-white/[0.05] border border-slate-200/70 dark:border-white/[0.08]">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${sev.bar}`} />
      <div className="pl-4 pr-3.5 py-3 flex items-center gap-4 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider font-black px-2 py-1 rounded-md shrink-0 ${sev.chip}`}>
          {a.severity}
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[14px] font-bold text-slate-900 dark:text-white truncate">
            {a.dependency}
            <span className="ml-2 font-sans text-[12px] font-medium text-slate-400 dark:text-slate-500">{a.ecosystem}</span>
          </p>
          <p className="text-[12.5px] text-slate-500 dark:text-slate-400 mt-0.5">
            <span className="font-mono">{a.vulnerable_version}</span>
            {a.patched_version
              ? <> → fixed in <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">{a.patched_version}</span></>
              : <> · <span className="font-semibold text-rose-600 dark:text-rose-400">no fix available</span></>}
          </p>
        </div>

        {a.cve && (
          <a href={`https://github.com/advisories?query=${encodeURIComponent(a.cve)}`}
            target="_blank" rel="noreferrer"
            title="Look up this advisory on GitHub"
            className="shrink-0 font-mono text-[12px] font-bold px-2.5 py-1.5 rounded-lg bg-white dark:bg-white/[0.07] border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 hover:border-blue-300 dark:hover:border-blue-700 transition-colors inline-flex items-center gap-1.5">
            {a.cve}<i className="ph-bold ph-arrow-square-out text-[11px]"></i>
          </a>
        )}
      </div>
    </li>
  );
}
