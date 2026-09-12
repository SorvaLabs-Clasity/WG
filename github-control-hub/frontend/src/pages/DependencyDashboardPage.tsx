import { useState, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchRenovate } from "../api/renovate";
import { useDependencies, useDependencySummary, useEnableDependabot, useDisableDependabot } from "../hooks/useDependencies";
import { useAuth } from "../App";
import type { DependencyAlert } from "../types/Dependabot";
import {
  Page, PageHeader, StatusSlab, SlabPercent, Button, Segmented, SearchInput,
  RailCard, Note, Pill, Empty, Spinner, Figure, Drawer, TYPE, INTENT, RefreshButton, enter, type Intent,
} from "../design";

/** Severity maps onto the shared intents so colour means one thing app-wide. */
const SEVERITY: Record<string, Intent> = {
  critical: "danger", high: "danger", medium: "warn", low: "info",
};

/** Each severity gets its own weight so a critical never reads like a low. */
const SEV_STYLE: Record<string, { chip: string; bar: string; rank: number }> = {
  critical: { chip: "bg-rose-600 text-reverse", bar: "bg-rose-500", rank: 0 },
  high: { chip: "bg-orange-600 text-reverse", bar: "bg-orange-500", rank: 1 },
  medium: { chip: "bg-amber-500 text-reverse", bar: "bg-amber-400", rank: 2 },
  low: { chip: "bg-slate-400 text-reverse", bar: "bg-slate-300", rank: 3 },
};

const REPOS_PER_PAGE = 15;
const COLLAPSED = 4;

import RenovatePanel from "../components/RenovatePanel";
import VulnNotifyPanel from "../components/VulnNotifyPanel";
import { usePermissions } from "../hooks/usePermissions";
import DependabotManager from "../components/DependabotManager";
import { bulkDependabot } from "../api/dependencies";
import { fetchDependenciesAge, fetchDependabotPrs, type DependabotPr } from "../api/dependencies";
import { READINESS, checkLabel, reviewLabel, type Readiness } from "../lib/prReadiness";
import { expectedFixPrs } from "../lib/fixExpectations";

/**
 * The three questions this tab answers, as three views rather than one column.
 *
 * Stacked, reaching Renovate means scrolling past the whole of Dependabot, a
 * page of repository cards, which puts the two halves of one question at
 * opposite ends of a scroll bar and makes the second easy to forget exists.
 *
 * They are separate questions asked by the same person at different moments:
 * what is vulnerable, what has been raised to fix it, and who gets told.
 * Nothing on one view needs anything from another to make sense.
 */
type View = "alerts" | "updates" | "notifications";

const VIEWS: View[] = ["alerts", "updates", "notifications"];

/**
 * Why this repository has findings and nothing open to fix them.
 *
 * Returns null where there is nothing to say, which includes the case that
 * matters most: `open` is null when the pull request search could not be made,
 * and "no pull requests are open" is then something nobody established. Saying
 * it anyway would send people to repositories that are already being fixed.
 */
function stuckReason(
  blocker: DependencyAlert["fixBlocker"],
  open: number | null,
): string | null {
  switch (blocker) {
    case "archived":
      return "Archived, so Dependabot cannot open a pull request here at all. "
        + "These findings stay until somebody unarchives it.";
    case "fixes-off":
      return "Security updates are off here, so no fix pull requests are raised.";
    case "no-patch":
      return "No patched version exists for any of these yet, so there is nothing "
        + "for Dependabot to open. Nothing is broken.";
    case "transitive":
      return "These sit underneath a parent dependency rather than in this "
        + "repository's own manifest, and Dependabot usually cannot bump them "
        + "without a change to the parent. A re-trigger will not help here.";
    case "config-target-branch":
      return "Its .github/dependabot.yml sets target-branch, which GitHub takes as "
        + "putting the configuration out of scope for security updates. No pull "
        + "request will arrive while that is set.";
  }
  // Nothing is wrong with the repository, which is what makes it worth showing:
  // the switch is on, patches exist, and GitHub has not done the work.
  if (blocker === null && open === 0) {
    return "Set up correctly and nothing open. GitHub has not scheduled these fixes.";
  }
  return null;
}

/**
 * The org-wide tally of repositories with findings and nothing open.
 *
 * A plain function rather than a hook, deliberately: this page has early
 * returns above the render, and a hook placed after one of them is React error
 * #310 in production. `repro-hookorder` guards the rule.
 *
 * Null when the pull request counts are unavailable, so the banner is absent
 * rather than wrong.
 */
function stuckSummary(alerts: DependencyAlert[], prCounts: Record<string, number> | null) {
  if (!prCounts) return null;

  const byRepo = new Map<string, DependencyAlert[]>();
  for (const a of alerts) {
    if (a.clean || a.disabled || a.scanning) continue;
    const list = byRepo.get(a.repo);
    if (list) list.push(a);
    else byRepo.set(a.repo, [a]);
  }

  let scheduled = 0, noPatch = 0, archived = 0, targetBranch = 0, fixesOff = 0, transitive = 0;
  for (const [repo, rows] of byRepo) {
    if ((prCounts[repo] ?? 0) > 0) continue;
    switch (rows[0]?.fixBlocker) {
      case "no-patch": noPatch++; break;
      case "transitive": transitive++; break;
      case "archived": archived++; break;
      case "config-target-branch": targetBranch++; break;
      case "fixes-off": fixesOff++; break;
      // Undefined means nothing was established about the repository, which is
      // not the same as nothing being wrong with it, so it is not counted as
      // waiting on GitHub.
      case null: scheduled++; break;
    }
  }
  const total = scheduled + noPatch + archived + targetBranch + fixesOff + transitive;
  return { total, scheduled, noPatch, archived, targetBranch, fixesOff, transitive };
}

export default function DependencyDashboardPage() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const { user } = useAuth();

  // In the URL, so the view survives a refresh and can be linked to. An
  // unrecognized value falls back rather than rendering nothing.
  /**
   * Whether the management panel is open.
   *
   * Not in the URL, unlike the view. It is a drawer somebody opens to do a
   * thing and closes again, and a link that reopened it for the next reader
   * would put a page of tick boxes in front of the findings they came for.
   */
  const [managing, setManaging] = useState(false);

  /**
   * How old the stored answer is.
   *
   * The tab paints from a stored sweep so it opens instantly, and without this
   * there is nothing to tell a reading taken seconds ago from one taken half an
   * hour ago. A page that looks equally current in both cases is the failure
   * this whole screen keeps having to avoid.
   */
  const { data: age } = useQuery({
    queryKey: ["dependencies", "age"],
    queryFn: fetchDependenciesAge,
    refetchInterval: 60_000,
  });

  /**
   * Open fix pull requests per repository, the other half of the question this
   * screen is asked. A hundred findings and an "auto-fix on" pill both look
   * healthy on their own; it is the two beside each other that show a
   * repository where nothing is happening.
   */
  const { data: prs } = useQuery({
    queryKey: ["dependencies", "fix-prs"],
    queryFn: fetchDependabotPrs,
    refetchInterval: 120_000,
  });
  const prCounts = prs?.counts ?? null;

  /**
   * The open pull requests, grouped by the repository they belong to, so each
   * card can show its own without every card walking the whole list.
   *
   * A plain loop rather than a hook: this page has early returns below, and a
   * hook after one of them is React error #310 in production. repro-hookorder
   * guards the rule.
   */
  const prsByRepo = new Map<string, DependabotPr[]>();
  for (const pr of prs?.prs ?? []) {
    const list = prsByRepo.get(pr.repo);
    if (list) list.push(pr);
    else prsByRepo.set(pr.repo, [pr]);
  }
  for (const list of prsByRepo.values()) {
    // Ready first, then oldest, which is the order somebody would clear them in.
    list.sort((a, b) => {
      const rank = (p: DependabotPr) => (p.readiness === "ready" ? 0 : 1);
      return rank(a) - rank(b) || b.ageDays - a.ageDays;
    });
  }

  const [params, setParams] = useSearchParams();
  const raw = params.get("view") as View | null;
  const view: View = raw && VIEWS.includes(raw) ? raw : "alerts";
  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === "alerts") next.delete("view"); else next.set("view", v);
    setParams(next, { replace: true });
  };

  // The same query key the panel uses, so this shares its cache rather than
  // fetching a second time. It is here only to put a count on the tab.
  const { data: renovate, isFetching: renovateFetching, refetch: refetchRenovate } = useQuery({
    queryKey: ["renovate"],
    queryFn: () => fetchRenovate(),
    staleTime: 120_000,
  });
  const renovateOpen = (renovate?.prs ?? []).filter(pr => pr.state === "open").length;
  const { data: dependencies, isLoading: depsLoading, isError: depsError, error: depsErrorObj,
          isFetching: depsFetching, refetch: refetchDeps } = useDependencies();
  const { data: summary, isLoading: sumLoading, isFetching: sumFetching, refetch: refetchSummary } = useDependencySummary();
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

  /**
   * Turn security updates on for one repository.
   *
   * Goes through the same bulk endpoint as the panel above, with a list of one.
   * A second route would be a second place for the pacing and the retry rules
   * to live, and this is the same write that trips the same limit.
   */
  const runFixes = async (repo: string) => {
    setBusyRepo(repo);
    setNotice(null);
    try {
      const out = await bulkDependabot([repo], "fixes-on");
      const failed = out.results.find(r => !r.ok);
      setNotice(failed
        ? { msg: `${repo}: ${failed.error}`, ok: false }
        // Said as a wait, not as a result. GitHub raises the pull requests on
        // its own schedule, and somebody watching for one to appear should
        // know it is not coming this second.
        : { msg: `${repo} will now get fix pull requests. GitHub opens them itself, usually within a few minutes.`, ok: true });
      await refetchDeps();
    } catch (e) {
      setNotice({ msg: (e as Error).message, ok: false });
    } finally {
      setBusyRepo(null);
    }
  };

  const [filter, setFilter] = useState<"alerts" | "critical" | "high" | "off" | "all">("alerts");
  const [search, setSearch] = useState("");
  const [busyRepo, setBusyRepo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Which repositories are showing their open fix pull requests. */
  const [showPrs, setShowPrs] = useState<Set<string>>(new Set());
  const togglePrs = (repo: string) => setShowPrs(prev => {
    const next = new Set(prev);
    next.has(repo) ? next.delete(repo) : next.add(repo);
    return next;
  });

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
    const watched = clean + vulnerable;
    return {
      off, clean, vulnerable, repos, watched,
      critical: summary?.critical ?? 0,
      high: summary?.high ?? 0,
      total: (summary?.critical ?? 0) + (summary?.high ?? 0) + (summary?.medium ?? 0) + (summary?.low ?? 0),
      // Coverage, not cleanliness. The old figure was clean/all-repos, which
      // counted every switched-off repo against "clean" and read as "99% of
      // your repos have vulnerabilities" when in fact none had been found,
      // those repos are unscanned, which is a different thing and a different
      // problem. Coverage is the number that is both true and actionable.
      pct: repos ? Math.round((watched / repos) * 100) : 100,
    };
  }, [dependencies, summary]);

  // Not an early return any more. Blocking the whole page on the Dependabot
  // fetch meant opening the Renovate view still waited for data it does not
  // use, the loading equivalent of the scroll this split removed.
  const alertsLoading = depsLoading || sumLoading;

  const rateLimited = depsError && (depsErrorObj as any)?.message?.includes("429");
  const totalPages = Math.max(1, Math.ceil(groups.length / REPOS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const shown = groups.slice((safePage - 1) * REPOS_PER_PAGE, safePage * REPOS_PER_PAGE);

  const stuck = stuckSummary(dependencies ?? [], prCounts);

  return (
    <Page user={user}>
      <PageHeader
        title="Vulnerabilities"
        subtitle={
          view === "alerts"
            ? "Known vulnerabilities in dependencies, and which repositories are watching for them."
            : view === "updates"
            ? "The pull requests Renovate has raised to move dependencies forward."
            : "Who gets emailed when something is found, or when an update is raised."
        }
        actions={
          <>
            {/* Only on the Dependabot view. The panel switches Dependabot, and
                offering it beside Renovate would be a control for a tool the
                page is not showing.

                Opens, never toggles: the drawer carries its own close, and a
                button reading "Hide" underneath the thing it hides is a
                control nobody can reach. */}
            {view === "alerts" && (
              <Button onClick={() => setManaging(true)}>
                <i className="ph-bold ph-sliders-horizontal mr-1.5 text-[12px]" aria-hidden="true" />
                Manage
              </Button>
            )}
            {/* Refreshes what you are looking at. Refetching all three from here
                would spend GitHub's rate limit on two views nobody has open. */}
            <RefreshButton
              busy={view === "updates" ? renovateFetching : depsFetching || sumFetching}
              onRefresh={() => view === "updates"
                ? refetchRenovate()
                : Promise.all([refetchDeps(), refetchSummary()])}
            />
          </>
        }
      />

      {/* One row: what you are looking at, and the state of the picture it is
          drawn from.

          These were three stacked bands, a staleness line, an amber summary and
          the management panel, sitting between the heading and the view
          switcher. Each was reasonable alone and together they pushed the
          findings somebody opened the tab for below the fold. The summary and
          the panel now share a drawer, because they are two halves of one
          question, and the staleness is four words rather than a band. */}
      <div className="mb-5 flex items-center justify-between gap-4 flex-wrap">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            // Named after the tool, not the noun: "Dependabot" and "Renovate"
            // are what people call these, and the ids stay as they are so any
            // link already pointing at ?view=updates keeps working.
            ["alerts", counts.total > 0 ? `Dependabot ${counts.total}` : "Dependabot"] as [View, string],
            ["updates", renovateOpen > 0 ? `Renovate ${renovateOpen}` : "Renovate"] as [View, string],
            ["notifications", "Notifications"] as [View, string],
          ]}
        />

        {view === "alerts" && (
          <div className="flex items-center gap-3">
            {stuck && stuck.total > 0 && (
              <button onClick={() => setManaging(true)}
                className="inline-flex items-center gap-1.5 text-[11.5px] font-bold
                           text-amber-700 dark:text-amber-400 rounded-lg px-2 py-1 -mx-1
                           hover:bg-amber-50 dark:hover:bg-amber-500/10 transition-colors">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden="true" />
                {stuck.total} without fixes
              </button>
            )}
            {/* A sweep that cannot be stored is a tab that recomputes the whole
                organization on every single opening, forever, with nothing on
                screen to say why. That is the shape of failure this codebase
                keeps rediscovering: an absence rendered as an answer. It costs
                a sentence to say instead. */}
            {age && !age.storing && age.problem && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] font-bold
                               text-rose-700 dark:text-rose-400 rounded-lg px-2 py-1 -mx-1"
                title={`${age.problem} Until that is fixed, every opening of this tab recomputes the whole organization.`}>
                <i className="ph-bold ph-warning-circle text-[12px]" aria-hidden="true" />
                not being stored
              </span>
            )}
            {age?.computedAt && (
              <span className="text-[11.5px] text-slate-400 dark:text-slate-500 tabular-nums"
                title={age.refreshing
                  ? "A fresh sweep is running now and will be here next time you look."
                  : "Opening this tab does not start a sweep. The stored one is served as it "
                    + "stands, and refreshed at most every half hour. Refresh forces one."}>
                <i className="ph-bold ph-clock-counter-clockwise mr-1 text-[11px]" aria-hidden="true" />
                swept {new Date(age.computedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                {/* Only when one is genuinely running. This used to be shown
                    for anything over ten minutes old, which was also when a
                    sweep was started, so it announced a rescan on every open
                    and then performed one. */}
                {age.refreshing && <span className="ml-1 opacity-60">(refreshing)</span>}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Over the page rather than pushing it, because this is a task with a
          beginning and an end and the page is not part of it. */}
      <Drawer
        open={view === "alerts" && managing}
        onClose={() => setManaging(false)}
        title="Manage Dependabot"
        subtitle="Every repository the last sweep saw. Pick as many as you like: the work is paced so GitHub does not refuse it, which is what happens when the same switches are flipped quickly one at a time."
      >
        {/* The breakdown first, because it is the reason somebody opened this:
            it says which repositories are worth selecting, and which cannot be
            helped by anything on this panel. */}
        {stuck && stuck.total > 0 && (
          <div className="mb-5 rounded-2xl border border-slate-200 dark:border-ink/[0.08] overflow-hidden">
            <div className="px-4 py-3 bg-slate-50/80 dark:bg-ink/[0.02] border-b border-slate-200/70 dark:border-ink/[0.07]">
              <p className="text-[13px] font-bold text-slate-900 dark:text-ink">
                {stuck.total} {stuck.total === 1 ? "repository has" : "repositories have"} findings and no fix pull request
              </p>
            </div>
            <dl className="divide-y divide-slate-100 dark:divide-ink/[0.05]">
              {([
                [stuck.scheduled, "Set up correctly, waiting on GitHub", "A re-trigger or the grouped config will help these."],
                [stuck.transitive, "Findings sit under a parent dependency", "Dependabot cannot bump these without the parent."],
                [stuck.noPatch, "No patch available yet", "Nothing to open. Not a failure."],
                [stuck.fixesOff, "Security updates are off", "Turn them on below."],
                [stuck.archived, "Archived", "No pull request can be opened at all."],
                [stuck.targetBranch, "dependabot.yml sets target-branch", "Puts the config out of scope for security updates."],
              ] as const).filter(([n]) => n > 0).map(([n, label, hint]) => (
                <div key={label} className="px-4 py-2.5 flex items-baseline gap-3">
                  <dt className="w-8 shrink-0 text-[15px] font-semibold tabular-nums text-slate-900 dark:text-ink">{n}</dt>
                  <dd className="min-w-0">
                    <span className="text-[12.5px] font-bold text-slate-700 dark:text-slate-200">{label}</span>
                    <span className="block text-[11.5px] text-slate-400 dark:text-slate-500">{hint}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <DependabotManager
          rows={dependencies ?? []}
          prCounts={prCounts}
          onDone={() => { refetchDeps(); refetchSummary(); }}
        />
      </Drawer>

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

      {view === "alerts" && (alertsLoading ? <Spinner /> : (
        <>
        <StatusSlab
          /* An org where almost nothing is being scanned is not "all clear",
             it is unmeasured. Saying so is the difference between a dashboard
             that reports and one that reassures. */
          intent={counts.critical > 0 ? "danger" : counts.total > 0 || counts.off > 0 ? "warn" : "good"}
          eyebrow={
            counts.critical > 0 ? "Critical vulnerabilities"
            : counts.total > 0 ? "Vulnerabilities open"
            : counts.off > 0 ? "Mostly unscanned"
            : "Nothing outstanding"
          }
          metrics={[
            { value: counts.critical, label: "critical", emphasis: true },
            { value: counts.high, label: "high" },
            { value: counts.off, label: "not watching" },
          ]}
          aside={<SlabPercent value={counts.pct} label="repos watched" />}
          footer={
            counts.off > 0
              ? <>
                  <strong className="font-bold">{counts.watched}</strong> of {counts.repos} repositories are being
                  scanned, and {counts.total === 0 ? "no vulnerabilities were found in them" : `${counts.total} open alerts were found in them`}.
                  The other <strong className="font-bold">{counts.off}</strong> {counts.off === 1 ? "has" : "have"} Dependabot
                  switched off, so nothing is known about {counts.off === 1 ? "it" : "them"} either way.
                </>
              : <>{counts.total} open alerts across {counts.repos} repositories, all of which are being scanned.</>
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
              // Just switched on and GitHub has not reported yet. Without this the
              // placeholder row rendered as a vulnerability named "Dependabot
              // alerts disabled" for the first few seconds after enabling.
              const scanning = !off && alerts.some(a => a.scanning);
              const clean = !off && !scanning && alerts.every(a => a.clean);
              const real = alerts.filter(a => !a.clean && !a.disabled && !a.scanning);
              const critical = real.filter(a => a.severity === "critical").length;
              const intent: Intent = off || scanning ? "neutral" : critical > 0 ? "danger" : real.length > 0 ? "warn" : "good";
              /**
               * Whether GitHub opens pull requests for this repository.
               *
               * Three states, not two. Undefined means the field was not
               * returned, which happens for a repository the signed-in account
               * does not administer, and offering "turn it on" there would be a
               * button that can only fail.
               */
              const fixes = alerts.find(a => a.fixesEnabled !== undefined)?.fixesEnabled;
              const openPrs = prCounts ? (prCounts[repo] ?? 0) : null;
              const repoPrs = prsByRepo.get(repo) ?? [];
              const prsOpen = showPrs.has(repo);
              const grouped = real.some(a => a.groupedConfig);
              const expected = expectedFixPrs(real, grouped);
              const stuck = stuckReason(real[0]?.fixBlocker, openPrs);
              const isOpen = expanded.has(repo);
              const visible = isOpen ? real : real.slice(0, COLLAPSED);
              const hidden = real.length - visible.length;

              return (
                <RailCard key={repo} intent={intent} index={i}>
                  <div className="flex items-start justify-between gap-5 flex-wrap mb-1">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className={`${TYPE.heading} text-slate-900 dark:text-ink`}>{repo}</h3>
                        {off && <Pill intent="neutral">not watching</Pill>}
                        {scanning && <Pill intent="info">scanning</Pill>}
                        {clean && <Pill intent="good">clean</Pill>}
                      </div>
                      {off && (
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>
                          Dependabot is switched off, so vulnerabilities here go undetected.
                        </p>
                      )}
                      {scanning && (
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-1.5`}>
                          <i className="ph-bold ph-circle-notch animate-spin text-[13px]"></i>
                          Just switched on. GitHub is still scanning. Results appear shortly.
                        </p>
                      )}
                      {clean && (
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>No known vulnerabilities.</p>
                      )}
                      {/* Why nothing is being opened, where something identifiable
                          is stopping it. Only on repositories that actually have
                          findings: it is an answer to "where are my pull
                          requests", and a clean repository never asked. */}
                      {!off && !clean && !scanning && stuck && (
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>{stuck}</p>
                      )}
                      {/* The unit people reach for is findings, and it is the
                          wrong one: one bump closes every alert against that
                          package. Said only where the two numbers differ enough
                          to mislead. */}
                      {!off && !clean && !scanning && expected > 0 && real.length > expected && (
                        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>
                          {grouped
                            ? `${real.length} findings are grouped into ${expected} pull request${expected === 1 ? "" : "s"}, one per manifest, not ${real.length}.`
                            : `${real.length} findings come from ${expected} package${expected === 1 ? "" : "s"}, so expect about ${expected} pull request${expected === 1 ? "" : "s"} here, not ${real.length}.`}
                          {openPrs !== null && openPrs > 0 && openPrs < expected
                            && " Dependabot raises them over several minutes."}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0 flex items-center gap-3">
                      {!off && !clean && !scanning && (
                        <Figure intent={critical > 0 ? "danger" : "warn"} value={real.length}
                          label={real.length === 1 ? "alert" : "alerts"} />
                      )}
                      {/* Beside the findings, because the gap between them is the
                          thing worth seeing. Withheld when the search failed:
                          a zero nobody measured reads as a repository to act on. */}
                      {!off && !clean && !scanning && openPrs !== null && (
                        <FixPrCount open={openPrs} expected={expected}
                          expandable={repoPrs.length > 0} expanded={prsOpen}
                          onToggle={() => togglePrs(repo)} />
                      )}

                      {org && (
                        <a href={`https://github.com/${org}/${repo}/security/dependabot`} target="_blank" rel="noreferrer"
                          className="stamp stamp-hollow">
                          <i className="ph-fill ph-github-logo"></i>GitHub
                        </a>
                      )}
                      {/* Only where scanning is on, because GitHub raises no
                          updates for a repository it is not scanning, and only
                          where the answer is known. */}
                      {!off && fixes === false && (
                        <Button disabled={busyRepo === repo}
                          onClick={() => runFixes(repo)}>
                          {busyRepo === repo ? "…" : "Auto-fix PRs"}
                        </Button>
                      )}
                      {!off && fixes === true && (
                        <Pill intent="good">auto-fix on</Pill>
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

                  {/* Above the findings, because these are what closes them,
                      and inside the card, because that is the repository they
                      belong to. */}
                  {prsOpen && repoPrs.length > 0 && (
                    <div className="mt-3 rounded-2xl bg-slate-50/80 dark:bg-ink/[0.02] border border-slate-200/80 dark:border-ink/[0.07] p-3">
                      <div className="flex items-baseline justify-between gap-3 mb-2 px-0.5">
                        <span className={`${TYPE.label} text-slate-500 dark:text-slate-400`}>
                          Open fix pull requests
                        </span>
                        <span className="text-[11.5px] text-slate-400 dark:text-slate-500">
                          {repoPrs.filter(p => p.readiness === "ready").length} ready to merge
                        </span>
                      </div>
                      <div className="grid gap-1.5">
                        {repoPrs.map(pr => <FixPrRow key={pr.id} pr={pr} />)}
                      </div>
                      {/* The one irreversible thing somebody can do from here,
                          said where they are about to do it. GitHub treats a
                          manual close as "do not raise this again", the same as
                          the @dependabot close command, and on a backlog this
                          size that is easy to do to a hundred of them before
                          noticing. */}
                      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-2.5 px-0.5 leading-relaxed">
                        Closing one without merging stops Dependabot raising it again.
                        Comment <span className="font-mono">@dependabot reopen</span> to undo that.
                      </p>
                    </div>
                  )}

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
        </>
      ))}

      {/* One view. It was two, the pull requests Renovate had raised and the
          dashboard listing what it would raise, which is the same subject split
          down the middle: an update it errored on and one it raised last week
          are the same question at two moments, and answering them in separate
          tabs meant checking both to learn where a repository stood. */}
      {view === "updates" && <RenovatePanel />}

      {/* Both notification panels together: "who gets told" is one question,
          and answering half of it on each of two other views is why the
          Renovate half went unread. */}
      {view === "notifications" && (
        <div className="space-y-8">
          <VulnNotifyPanel feed="dependabot-alert" isAdmin={isAdmin} />
          <VulnNotifyPanel feed="renovate-pr" isAdmin={isAdmin} />
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
/**
 * One open Dependabot pull request, inside the card for the repository it
 * belongs to.
 *
 * The whole row is the link out. This app never merges: merging is GitHub's
 * job, where GitHub authorizes the person doing it against the repository.
 *
 * A left edge coloured by readiness, so a column of these can be read at a
 * glance without any of the words being read. Every fact after it is withheld
 * rather than guessed at when it did not come back, so a blank space here
 * means "not established", never "fine".
 */
/**
 * The fix-pull-request count on a repository card, and the way in to them.
 *
 * Its own component because the first version wrapped the shared `Figure` in a
 * button and hung a caret and the word "view" underneath it. That put four
 * things in a space sized for two, and next to the plain alerts figure beside
 * it the pair no longer read as a pair.
 *
 * So the number is laid out here directly, matching the figure it sits beside,
 * with the chevron on the baseline of the label rather than on a line of its
 * own. Nothing says "view": a chevron already does, and the word was the part
 * that made it crowded.
 */
function FixPrCount({ open, expected, expandable, expanded, onToggle }: {
  open: number;
  expected: number;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const intent: Intent = expected > 0 && open >= expected ? "good" : open > 0 ? "info" : "neutral";
  const body = (
    <>
      {/* The count on its own. It read "4/18", and the denominator was a
          ceiling this app derived rather than a number GitHub reports, so it
          invited being read as a shortfall against a target somebody set. The
          line under the card still explains why a hundred findings do not
          become a hundred pull requests. */}
      <div className={`${TYPE.metricSm} ${INTENT[intent].figure} tabular-nums`}>
        {open}
      </div>
      <div className="flex items-center gap-1 mt-0.5">
        <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>
          {expected > 0 || open !== 1 ? "fix PRs" : "fix PR"}
        </span>
        {expandable && (
          <i className={`ph-bold ph-caret-down text-[9px] text-slate-400 dark:text-slate-500
                         transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        )}
      </div>
    </>
  );

  // Not a button when there is nothing behind it, so the hover state never
  // promises something that does not open.
  if (!expandable) return <div className="text-right">{body}</div>;

  return (
    <button onClick={onToggle} aria-expanded={expanded}
      title={`${expanded ? "Hide" : "Show"} the ${open} open fix pull request${open === 1 ? "" : "s"}`}
      className="text-right rounded-xl -m-1.5 p-1.5 hover:bg-slate-100 dark:hover:bg-ink/[0.06] transition-colors">
      {body}
    </button>
  );
}

function FixPrRow({ pr }: { pr: DependabotPr }) {
  const state = (pr.readiness ?? "unknown") as Readiness;
  const r = READINESS[state];
  const checks = checkLabel(pr.checks);
  const review = reviewLabel(pr.reviewDecision);

  return (
    <a href={pr.url} target="_blank" rel="noopener noreferrer" title={r.hint}
      className="group flex items-center gap-3 rounded-xl pl-0 pr-3 py-2 overflow-hidden
                 bg-white dark:bg-ink/[0.03] border border-slate-200/80 dark:border-ink/[0.07]
                 hover:border-slate-300 dark:hover:border-ink/20 transition-colors">
      <span className={`w-1 self-stretch shrink-0 rounded-l-xl ${INTENT[r.intent].mark}`} aria-hidden="true" />

      <span className="min-w-0 flex-1 flex items-baseline gap-2 flex-wrap">
        {/* The package, where the branch named one. A grouped pull request
            names none, and its title already reads correctly, so that is what
            shows instead of an invented name. */}
        {pr.packageName ? (
          <>
            <span className="font-mono text-[12.5px] font-bold text-slate-800 dark:text-slate-100 truncate">
              {pr.packageName}
            </span>
            <span className="text-[11.5px] text-slate-400 dark:text-slate-500 truncate">{pr.title}</span>
          </>
        ) : (
          <span className="text-[12.5px] font-semibold text-slate-800 dark:text-slate-100 truncate">
            {pr.title}
          </span>
        )}
        {pr.draft && <Pill intent="neutral">draft</Pill>}
      </span>

      <span className="shrink-0 flex items-center gap-2.5 text-[11.5px] text-slate-500 dark:text-slate-400">
        {checks && (
          <span className={
            pr.checks === "SUCCESS" ? "text-emerald-700 dark:text-emerald-400 font-bold"
              : pr.checks === "FAILURE" || pr.checks === "ERROR" ? "text-rose-700 dark:text-rose-400 font-bold"
              : ""
          }>{checks}</span>
        )}
        {review && <span className="hidden sm:inline">{review}</span>}
        {pr.mergeable === "CONFLICTING" && (
          <span className="text-amber-700 dark:text-amber-400 font-bold">conflicts</span>
        )}
        {pr.changedFiles !== undefined && (
          <span className="hidden md:inline tabular-nums">
            <span className="text-emerald-700 dark:text-emerald-400">+{pr.additions ?? 0}</span>{" "}
            <span className="text-rose-700 dark:text-rose-400">-{pr.deletions ?? 0}</span>
          </span>
        )}
        <span className="tabular-nums">{pr.ageDays}d</span>
        <span className="tabular-nums text-slate-400 dark:text-slate-500">#{pr.number}</span>
        <i className="ph-bold ph-arrow-up-right text-[11px] opacity-40 group-hover:opacity-100 transition-opacity" />
      </span>
    </a>
  );
}

function VulnRow({ alert: a }: { alert: DependencyAlert }) {
  const sev = SEV_STYLE[a.severity] ?? SEV_STYLE.low;
  return (
    <li className="relative overflow-hidden rounded-xl bg-slate-50 dark:bg-ink/[0.05] border border-slate-200/70 dark:border-ink/[0.08]">
      <span className={`absolute left-0 top-0 bottom-0 w-1 ${sev.bar}`} />
      <div className="pl-4 pr-3.5 py-3 flex items-center gap-4 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-md shrink-0 ${sev.chip}`}>
          {a.severity}
        </span>

        <div className="min-w-0 flex-1">
          <p className="font-mono text-[14px] font-bold text-slate-900 dark:text-ink truncate">
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
            className="stamp stamp-hollow shrink-0">
            {a.cve}<i className="ph-bold ph-arrow-square-out text-[11px]"></i>
          </a>
        )}
      </div>
    </li>
  );
}
