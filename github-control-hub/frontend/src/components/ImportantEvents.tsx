import { useState, useMemo, useRef } from "react";
import { useAlerts } from "../hooks/useAlerts";
import { usePermissions } from "../hooks/usePermissions";
import ImportantEventsPanel from "./ImportantEventsPanel";
import {
  toSituations, isRestingState, weeklyActivity, summarizeKinds, summarizeRepos,
  recent, wasReverted, countBySeverity, RECENT_DAYS, SEVERITIES,
  type Severity, type Situation,
} from "../lib/alertSituations";
import { ActivityChart, Spark, SEVERITY_BAR, SEVERITY_DOT } from "./AlertCharts";
import {
  StatusSlab, Button, Empty, Spinner, LoadFailed,
  Pill, TYPE, INTENT, SURFACE, enter, type Intent, RefreshButton,
  SearchInput, Pager,
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
const label = (t: string) => TYPE_LABELS[t] ?? t;

/** Severity maps onto the shared intents so colour means the same thing everywhere. */
const SEVERITY: Record<string, Intent> = {
  critical: "danger", high: "danger", medium: "warn", low: "info",
};
const sevIntent = (s?: string) => SEVERITY[(s ?? "").toLowerCase()] ?? "neutral";


/**
 * Weeks the charts cover.
 *
 * Matches the server's default window. Where the server could not fit that
 * window in one response the page says so rather than drawing a shorter span
 * under a twelve-week heading.
 */
const WEEKS = 12;
/**
 * Groups per page.
 *
 * Ten rather than twelve so a page break actually happens on an ordinary
 * organization. At twelve, an account with eleven groups had one page, and the
 * pager hides itself when there is only one, so the list simply ran off the
 * bottom with no count and no controls anywhere.
 */
const SITUATIONS_PER_PAGE = 10;

/**
 * Every way the page can be narrowed, in one place.
 *
 * One list, with everything above it a filter. Two lists answering different
 * questions from the same data will always find a way to contradict each other:
 * a summary of every alert beside a list defaulting to unresolved ones shows
 * seventeen things and none, both behaving as written.
 *
 * The section is called "Important events" because almost every row is a
 * legitimate action, a repository made public on purpose or somebody given the
 * access they were hired to have. "Security alert" promises a vulnerability and
 * delivers a changelog.
 */
interface Filters {
  kind: string | null;
  repo: string | null;
  severity: string | null;
  /** Start-of-week in ms, from the activity chart. */
  week: number | null;
  search: string;
}

const NO_FILTERS: Filters = {
  kind: null, repo: null, severity: null, week: null, search: "",
};

/**
 * Important events: what has changed across the organization.
 *
 * A view inside Activity, not a page. It was the whole Security tab, under the
 * name "security alerts", and the name was the problem: almost every row is a
 * legitimate action. A repository made public on purpose. Somebody given the
 * access they were hired to have. Calling that an alert promises a
 * vulnerability and delivers a changelog, and it is what made the tab read as
 * a queue.
 *
 * It belongs beside the activity streams because that is what it is: the same
 * events, read through a dashboard rather than a table. Activity answers "what
 * happened, exactly"; this answers "what has been happening, and is any of it
 * unusual".
 *
 * Everything the page had is here unchanged. The chart, the per-kind tiles with
 * their own history, the repository chips, the grouped rows that open to the
 * events inside them, and every one of them still a filter on the list below.
 */
export default function ImportantEvents() {
  const {
    data: alerts, isLoading, isError, error, isFetching, refetch,
    complete, windowWeeks, hasNextPage, fetchNextPage, isFetchingNextPage,
  } = useAlerts();
  const { data: permissions } = usePermissions();

  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const listRef = useRef<HTMLElement>(null);

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    setF(prev => ({ ...prev, [k]: v }));
    setPage(1);
  };

  /**
   * Click the tile that is already on to turn it off, and go to the result.
   *
   * Without the scroll the tiles read as broken. The list they filter sits
   * below the charts and is usually off screen, so clicking one lit it up and
   * appeared to do nothing else. Only on the way *in*: being thrown down the
   * page for clearing a filter is its own surprise.
   */
  const toggle = <K extends keyof Filters>(k: K, v: Filters[K]) => {
    const turningOn = f[k] !== v;
    set(k, (turningOn ? v : null) as Filters[K]);
    if (turningOn) reveal();
  };

  function reveal() {
    const el = listRef.current;
    if (!el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    // After the state lands, so the list has been redrawn before it is
    // scrolled to. Scrolling to the old list and then swapping its contents
    // underneath reads as the page jumping on its own.
    requestAnimationFrame(() =>
      el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" }));
  }

  const all = useMemo(() => alerts ?? [], [alerts]);

  /** The oldest row that has actually loaded, which bounds every claim below. */
  const oldestLoaded = useMemo(
    () => all.reduce((m, a) => (a.timestamp < m ? a.timestamp : m), all[0]?.timestamp ?? ""),
    [all],
  );

  // ── the dashboard reads the whole set, always ─────────────────────────
  // Deliberately not the filtered one. A chart that redraws itself from what
  // you just clicked cannot show you where the click sits in the whole, which
  // is the only thing a chart is for.
  const lately = useMemo(() => recent(all), [all]);
  // Above the early returns, with every other hook.
  //
  // This sat below them, next to the prose it feeds, and that is React error
  // #310: the loading render stopped at the guard and ran one hook fewer than
  // the render after it. The page then crashed the moment the query resolved.
  // It survived on the old Security tab only because the query was usually
  // already warm, so `isLoading` was never true on a first render there.
  const bySeverity = useMemo(() => countBySeverity(lately), [lately]);
  const buckets = useMemo(() => weeklyActivity(all, WEEKS), [all]);
  const kinds = useMemo(() => summarizeKinds(all, WEEKS), [all]);
  const repos = useMemo(() => summarizeRepos(all), [all]);
  const resting = useMemo(() => isRestingState(all), [all]);
  const rising = kinds.filter(k => k.direction === "up" || k.direction === "new").length;

  const counts = useMemo(() => ({
    all: all.length,
    reverted: all.filter(wasReverted).length,
  }), [all]);

  // ── the list reads the filtered one ───────────────────────────────────
  const matching = useMemo(() => {
    const q = f.search.trim().toLowerCase();
    return all.filter(a => {
      if (f.kind && a.type !== f.kind) return false;
      if (f.repo && a.repo !== f.repo) return false;
      if (f.severity && (a.severity ?? "").toLowerCase() !== f.severity) return false;
      if (f.week !== null) {
        const t = Date.parse(a.timestamp);
        if (!(t > f.week && t <= f.week + 7 * 86_400_000)) return false;
      }
      if (q && !`${a.repo} ${label(a.type)} ${a.message ?? ""} ${a.severity} ${a.actor ?? ""}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [all, f]);

  // Grouped after filtering, so narrowing to one week regroups within it
  // rather than showing groups that reach outside what was asked for.
  const situations = useMemo(() => toSituations(matching), [matching]);
  const byId = useMemo(() => new Map(all.map(a => [a.id, a])), [all]);

  // The unfiltered total, so the pager can say "3 of 11 groups" rather than
  // "3 groups" and leave somebody wondering where the rest went.
  const allSituations = useMemo(() => toSituations(all), [all]);

  const totalPages = Math.max(1, Math.ceil(situations.length / SITUATIONS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const visible = situations.slice((safePage - 1) * SITUATIONS_PER_PAGE, safePage * SITUATIONS_PER_PAGE);

  const active = [
    f.kind && { k: "kind" as const, text: label(f.kind) },
    f.repo && { k: "repo" as const, text: f.repo },
    f.severity && { k: "severity" as const, text: f.severity.toUpperCase() },
    f.week !== null && {
      k: "week" as const,
      text: `week of ${new Date(f.week).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    },
    f.search.trim() && { k: "search" as const, text: `"${f.search.trim()}"` },
  ].filter(Boolean) as Array<{ k: keyof Filters; text: string }>;

  if (isLoading) return <Spinner />;

  // Before any count is read: an unread list counts as zero, which renders as
  // the all-clear.
  if (isError) {
    return <LoadFailed what="important events" error={error} onRetry={refetch} />;
  }

  /**
   * Severity decides the headline, and rate is the tiebreak.
   *
   * The other way round, an organization that makes a repository public most
   * weeks gets a calm blue "Nothing unusual" over a repository that has just
   * gone public. A rate comparison can only say "more than usual", and the
   * thing most worth seeing is often exactly one of something that has happened
   * before, so one critical is enough.
   */
  const tone: Intent =
    bySeverity.critical > 0 ? "danger"
      : bySeverity.high > 0 || rising > 0 ? "warn"
      : "good";
  const eyebrow =
    bySeverity.critical > 0
      ? `${bySeverity.critical} critical this week`
      : bySeverity.high > 0 ? "High severity this week"
      : rising > 0 ? "Above its usual rate"
      : lately.length === 0 ? "A quiet week"
      : "Nothing unusual";

  return (
    <>
      {/* The headline is what happened, not what is outstanding.
          It used to count alerts "wanting a decision", which on an
          organization where every change is deliberate is a number that only
          grows and that nobody can act on. */}
      <StatusSlab
        intent={tone}
        eyebrow={eyebrow}
        metrics={[
          // Critical first and emphasised when there is one, because it is the
          // number that decides whether anybody needs to look.
          ...(bySeverity.critical > 0
            ? [{ value: bySeverity.critical, label: "critical", emphasis: true }]
            : []),
          { value: lately.length, label: `in the last ${RECENT_DAYS} days`, emphasis: bySeverity.critical === 0 },
          { value: rising, label: "above normal" },
        ]}
        footer={
          bySeverity.critical > 0
            ? <>Critical events do not wait for a rate to look unusual. They are in
                the last {RECENT_DAYS} days below.</>
          : rising > 0
            ? <>Something is running above its usual rate. The tiles below say which.</>
            : <>{counts.all} {counts.all === 1 ? "event" : "events"}
                {complete ? <> on record over {windowWeeks} weeks</> : <> loaded so far</>}.
                They age out on their own; there is nothing to clear.</>
        }
      />

      {/* ── what has happened lately ──────────────────────────────────────
          This replaced the queue. It answers the same question somebody
          opened the tab for, and it empties itself whether or not anyone
          looks at it. */}
      {counts.all > 0 && (
        <section className={`${SURFACE.card} p-5 mb-4`} style={enter(0)}>
          <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
            <h2 className={TYPE.heading}>Last {RECENT_DAYS} days</h2>
            <span className="text-[12px] text-slate-400 dark:text-slate-500">
              {lately.length === 0 ? "nothing to show" : "no action needed"}
            </span>
          </div>

          {lately.length === 0 ? (
            <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400`}>
              Nothing has been reported this week. The record below goes back {WEEKS} weeks.
            </p>
          ) : (
            <div className="grid gap-1">
              {lately.slice(0, 8).map(a => (
                <div key={a.id} className="flex items-baseline gap-3 py-1.5 border-b last:border-b-0 border-slate-100 dark:border-white/[0.05]">
                  <span className={`shrink-0 w-1.5 h-1.5 rounded-full translate-y-[-1px]
                    ${SEVERITY_BAR[(a.severity ?? "low").toLowerCase() as Severity] ?? "bg-slate-300"}`} />
                  <span className="text-[13px] font-semibold text-slate-700 dark:text-slate-200 shrink-0">
                    {label(a.type)}
                  </span>
                  <span className="text-[12.5px] text-slate-500 dark:text-slate-400 truncate min-w-0 flex-1">
                    {a.repo}{a.actor ? ` · by ${a.actor}` : a.source === "reconciliation" ? " · no webhook" : ""}
                  </span>
                  {wasReverted(a) && (
                    <span className="shrink-0 text-[10.5px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      undone
                    </span>
                  )}
                  <span className="shrink-0 text-[11.5px] text-slate-400 dark:text-slate-500 tabular-nums">
                    {ago(a.timestamp)}
                  </span>
                </div>
              ))}
              {lately.length > 8 && (
                <p className="text-[12px] text-slate-400 dark:text-slate-500 pt-2">
                  and {lately.length - 8} more, in the record below
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {counts.all === 0 ? (
        <Empty
          title="Nothing recorded yet"
          body="Events appear here as GitHub reports them: branch protection changes, repositories going public, admin access being granted."
        />
      ) : (
        <>
          {/* ── the shape of the window ──────────────────────────────────── */}
          <section className={`${SURFACE.card} p-5 sm:p-6 mb-4`} style={enter(0)}>
            <div className="flex items-start justify-between gap-4 flex-wrap mb-5">
              <div>
                <h2 className={TYPE.heading}>Activity</h2>
                <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-0.5`}>
                  {/* Not "12 weeks" unless twelve weeks were actually read. A
                      chart drawn from a truncated set under a full heading is
                      the exact shape of lie this page keeps being rebuilt to
                      remove. */}
                  {complete
                    ? <>{windowWeeks} weeks. Click a week to see only what happened in it.</>
                    : <>Since {shortDate(oldestLoaded)}, which is as far back as has loaded.
                        Click a week to see only what happened in it.</>}
                </p>
              </div>
              {/* A legend that is also the severity filter, because a reader
                  who has just worked out what the colours mean is exactly the
                  reader who wants to see one of them on its own. */}
              <div className="flex items-center gap-1">
                {SEVERITIES.map(s => {
                  const n = all.filter(a => (a.severity ?? "").toLowerCase() === s).length;
                  if (n === 0) return null;
                  const on = f.severity === s;
                  return (
                    <button key={s} type="button" onClick={() => toggle("severity", s)} aria-pressed={on}
                      className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] font-semibold transition-colors
                        ${on ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                             : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.07]"}`}>
                      <span className={`w-2 h-2 rounded-sm ${SEVERITY_DOT[s]}`} />
                      {s} <span className="tabular-nums opacity-60">{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <ActivityChart buckets={buckets} selected={f.week}
              onSelect={w => { set("week", w); if (w !== null) reveal(); }} />
          </section>

          {/* ── what kinds of thing, and whether each is normal ──────────── */}
          <section className="mb-4">
            <SectionHead
              title="By kind"
              sub="Each with its own history, so a zero this week reads as quiet rather than as missing."
            />
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {kinds.map((k, i) => {
                const on = f.kind === k.type;
                const intent = sevIntent(k.worst);
                const notable = k.direction === "up" || k.direction === "new";
                return (
                  <button
                    key={k.type} type="button" onClick={() => toggle("kind", k.type)} aria-pressed={on}
                    style={enter(i, 30)}
                    className={`text-left rounded-2xl border p-4 transition-all duration-200
                      focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/30
                      ${on
                        ? "border-slate-900 dark:border-white bg-white dark:bg-[#151a23] shadow-md -translate-y-0.5"
                        : `border-slate-200/80 dark:border-white/[0.09] bg-white dark:bg-[#151a23] ${SURFACE.cardHover}`}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-[13.5px] font-bold text-slate-800 dark:text-slate-100 leading-tight">
                        {label(k.type)}
                      </span>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${INTENT[intent].mark}`}
                            aria-label={`worst severity ${k.worst}`} />
                    </div>

                    <div className="flex items-end justify-between gap-3 mt-2.5">
                      <div>
                        <div className={`text-[30px] font-black tabular-nums leading-none tracking-tight
                          ${notable ? INTENT[intent].figure : "text-slate-800 dark:text-slate-100"}`}>
                          {k.total}
                        </div>
                        <div className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                          across {k.repos} {k.repos === 1 ? "repository" : "repositories"}
                        </div>
                      </div>
                      <Spark values={k.spark} label={label(k.type).toLowerCase()}
                        intent={notable ? INTENT[intent].mark : "bg-slate-300 dark:bg-slate-600"} />
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-slate-100 dark:border-white/[0.06]
                                    flex items-center justify-between gap-2">
                      <span className={`text-[11.5px] font-semibold ${notable ? INTENT[intent].text : "text-slate-400 dark:text-slate-500"}`}>
                        {trendWords(k)}
                      </span>
                      {/* How bad this kind gets, which is the durable fact.
                          It used to read "N open", a number that only ever
                          grew and that could be driven to zero by clicking
                          rather than by anything changing on GitHub. */}
                      <span className={`text-[10.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded
                                        ${INTENT[intent].soft} ${INTENT[intent].text}`}>
                        {k.worst}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── which repositories keep coming up ────────────────────────── */}
          {repos.length > 1 && (
            <section className={`${SURFACE.card} p-5 mb-8`}>
              <h2 className={`${TYPE.heading} mb-0.5`}>Repositories involved</h2>
              <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mb-3.5`}>
                One repository under four kinds of alert is a different problem from four
                repositories with one each.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {repos.slice(0, 14).map(r => {
                  const on = f.repo === r.repo;
                  return (
                    <button key={r.repo} type="button" onClick={() => toggle("repo", r.repo)} aria-pressed={on}
                      className={`group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-xl border text-[12.5px] font-semibold transition-all
                        ${on ? "border-slate-900 dark:border-white bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                             : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-slate-400 dark:hover:border-white/30"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-current opacity-70" : INTENT[sevIntent(r.worst)].mark}`} />
                      <span className="truncate max-w-[190px]">{r.repo}</span>
                      <span className={`tabular-nums text-[11px] px-1.5 py-0.5 rounded-md
                        ${on ? "bg-white/20 dark:bg-slate-900/15" : "bg-slate-100 dark:bg-white/[0.07] text-slate-500 dark:text-slate-400"}`}>
                        {r.total}
                      </span>
                    </button>
                  );
                })}
                {repos.length > 14 && (
                  <span className="self-center text-[12px] text-slate-400 dark:text-slate-500 px-1">
                    and {repos.length - 14} more
                  </span>
                )}
              </div>
            </section>
          )}

          {/* ── the one list ─────────────────────────────────────────────── */}
          <section ref={listRef} className="scroll-mt-24">
            <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
              <div>
                <h2 className={TYPE.heading}>
                  {active.length ? "Matching events"
                    : complete ? "Everything recorded"
                    : "Everything loaded"}
                </h2>
                <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-0.5`}>
                  Grouped by what caused them. One action across many repositories is one row.
                  Open a row to see the alerts inside it.
                </p>
              </div>
              {/* No open/resolved toggle. Nothing is open, so a control
                  offering to hide the resolved ones would be offering to hide
                  everything. */}
              <SearchInput value={f.search} onChange={v => set("search", v)} placeholder="Search events…" />
            </div>

            {/* Every narrowing in one row, each removable on its own. Filters
                set by clicking a chart are otherwise invisible, and an empty
                list with no visible reason for being empty reads as a bug. */}
            {active.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap mb-3.5">
                <span className={`${TYPE.label} text-slate-400 dark:text-slate-500`}>Showing</span>
                {active.map(a => (
                  <button key={a.k} type="button"
                    onClick={() => set(a.k, (a.k === "search" ? "" : null) as any)}
                    className="group flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-lg text-[12px] font-semibold
                               bg-slate-900 text-white dark:bg-white dark:text-slate-900 hover:opacity-80 transition-opacity">
                    {a.text}
                    <span className="opacity-50 group-hover:opacity-100 text-[13px] leading-none">×</span>
                  </button>
                ))}
                <button type="button" onClick={() => { setF(NO_FILTERS); setPage(1); }}
                  className="text-[12px] font-semibold text-slate-400 dark:text-slate-500 hover:text-slate-900 dark:hover:text-white px-1.5 transition-colors">
                  clear all
                </button>
              </div>
            )}

            {visible.length === 0 ? (
              <Empty
                title="Nothing matches"
                body={`None of the ${counts.all} recorded events match what is selected above.`}
                action={<Button variant="secondary" onClick={() => { setF(NO_FILTERS); setPage(1); }}>Clear filters</Button>}
              />
            ) : (
              <div className="grid gap-2">
                {visible.map((s, i) => (
                  <SituationRow
                    key={s.key} s={s} index={i}
                    open={expanded === s.key}
                    onToggle={() => setExpanded(expanded === s.key ? null : s.key)}
                    alerts={s.ids.map(id => byId.get(id)!).filter(Boolean)}
                  />
                ))}
              </div>
            )}

            <Pager
              page={safePage} totalPages={totalPages} onPage={setPage}
              matchCount={situations.length} totalCount={allSituations.length}
              filtered={active.length > 0} noun="groups"
            />

            {/* Said out loud, because a list that ends is indistinguishable
                from a list that ran out. Search and the charts above cover
                what has loaded and nothing else, and somebody filtering to
                nothing deserves to know there is more behind it. */}
            {!complete && (
              <div className="mt-4 rounded-xl border border-amber-200 dark:border-amber-500/30
                              bg-amber-50 dark:bg-amber-500/[0.1] px-4 py-3
                              flex items-center justify-between gap-4 flex-wrap">
                <p className="text-[12.5px] text-amber-800 dark:text-amber-200">
                  Showing {all.length} alerts back to {shortDate(oldestLoaded)}. There are
                  older ones. Everything above, including search, covers only what has loaded.
                </p>
                <Button variant="secondary" disabled={!hasNextPage || isFetchingNextPage}
                  onClick={() => fetchNextPage()}>
                  {isFetchingNextPage ? "Loading…" : "Load older"}
                </Button>
              </div>
            )}
          </section>
        </>
      )}

      {/* Who hears about these, and how quickly.
          Under the events rather than in a settings screen, because the
          question "should somebody be emailed about this?" arrives while
          looking at one, not while looking for a preferences page. */}
      <div className="mt-12">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-1">Notifications</h2>
        <p className="text-sm text-gray-600 dark:text-slate-400 mb-4">
          Email delivery for the events above. Groups are created on the Alarms page.
        </p>
        <ImportantEventsPanel isAdmin={permissions?.isAwsAdmin ?? false} />
      </div>
    </>
  );
}
/* ── pieces ───────────────────────────────────────────────────────────── */

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-3.5">
      <h2 className={TYPE.heading}>{title}</h2>
      <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-0.5`}>{sub}</p>
    </div>
  );
}

/**
 * One group, and the alerts inside it.
 *
 * The group used to be the end of the road: a row saying "4 repositories" with
 * no way to find out which four or to do anything about them. The alerts it
 * covers are already loaded, so the expansion costs a click and no request.
 */
function SituationRow({ s, index, open, onToggle, alerts }: {
  s: Situation;
  index: number;
  open: boolean;
  onToggle: () => void;
  // The shape this row reads, spelled out rather than inherited, because it is
  // fed from `byId` and not from the query type.
  alerts: Array<{
    id: string; repo: string; message?: string; severity: string; timestamp: string;
    actor?: string; subject?: string; source?: "reconciliation";
    resolved?: boolean; resolvedBy?: string; details?: any;
  }>;
}) {
  const intent = sevIntent(s.severity);
  const spread = s.first !== s.last;

  return (
    <div style={enter(index, 25)}
      className={`rounded-2xl border overflow-hidden transition-all duration-200
        ${open ? "border-slate-300 dark:border-white/20 shadow-md" : "border-slate-200/80 dark:border-white/[0.09]"}
        bg-white dark:bg-[#151a23]`}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full text-left px-4 py-3.5 flex items-center gap-3.5
                   hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900/20 dark:focus-visible:ring-white/30">
        <span className={`shrink-0 w-1 self-stretch rounded-full ${INTENT[intent].mark}`} />

        <i className={`ph-bold ph-caret-right shrink-0 text-slate-300 dark:text-slate-600 text-[12px]
                       transition-transform duration-200 ${open ? "rotate-90" : ""}`} aria-hidden="true" />

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-bold text-slate-800 dark:text-slate-100">{label(s.type)}</span>
            <Pill intent={intent}>{String(s.severity).toUpperCase()}</Pill>
            {/* Only where GitHub actually reversed the change. This read
                `unresolved === 0`, which on an account where somebody had
                worked through the old queue was true of every group, so every
                group claimed to have been undone. */}
            {s.reverted > 0 && (
              <Pill intent="good">
                {s.reverted === s.count ? "undone" : `${s.reverted} of ${s.count} undone`}
              </Pill>
            )}
          </span>
          <span className="block text-[12.5px] text-slate-500 dark:text-slate-400 mt-1 truncate">
            {s.repos.length === 1
              ? s.repos[0]
              : `${s.repos.slice(0, 3).join(", ")}${s.repos.length > 3 ? ` and ${s.repos.length - 3} more` : ""}`}
          </span>
        </span>

        <span className="shrink-0 text-right">
          <span className="block text-[14px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
            {s.repos.length > 1 ? `${s.repos.length} repos` : `${s.count} ${s.count === 1 ? "alert" : "alerts"}`}
          </span>
          <span className="block text-[11.5px] text-slate-400 dark:text-slate-500 mt-0.5">
            {shortDate(s.last)}{spread && ` · over ${spanWords(s.first, s.last)}`}
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 dark:border-white/[0.07] bg-slate-50/60 dark:bg-white/[0.02]">
          {alerts.length === 0 ? (
            <p className="px-4 py-3 text-[12.5px] text-slate-500 dark:text-slate-400">
              These alerts are no longer in the loaded set.
            </p>
          ) : alerts.map(a => (
            <div key={a.id} className="px-4 py-3 border-b last:border-b-0 border-slate-100 dark:border-white/[0.05]
                                       flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${SEVERITY_BAR[(a.severity ?? "low").toLowerCase() as Severity] ?? "bg-slate-300"}`} />
                  <span className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">{a.repo}</span>
                  {/* "Undone", not "resolved". The only thing `resolved` still
                      records is that the change was reversed on GitHub, which
                      is a fact about the repository. It used to also mean
                      somebody had pressed a button, and conflating the two is
                      what made a reversal indistinguishable from an
                      acknowledgement. */}
                  {wasReverted(a) && (
                    <span className="text-[10.5px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      undone since
                    </span>
                  )}
                </div>
                <p className="text-[12.5px] mt-1 text-slate-600 dark:text-slate-300">{a.message}</p>
                <p className="text-[11.5px] text-slate-400 dark:text-slate-500 mt-1.5">
                  {/* A reconciliation alert's timestamp is when the nightly
                      walk noticed, not when it happened, and the two render
                      identically unless it is said out loud. */}
                  {a.source === "reconciliation" ? <>found {when(a.timestamp)}</> : when(a.timestamp)}
                  {/* The first question anybody asks about a privilege change,
                      and until now the answer was not recorded at all. */}
                  {a.actor && <> · by <span className="font-semibold text-slate-500 dark:text-slate-400">{a.actor}</span></>}
                </p>
                {a.source === "reconciliation" && (
                  <p className="text-[11.5px] mt-1.5 text-amber-700 dark:text-amber-300">
                    Found by the nightly check, not reported by GitHub. Nobody knows
                    who made this change, and it happened some time before it was found.
                  </p>
                )}
                {a.details && (
                  <pre className="mt-2.5 p-2.5 rounded-lg bg-white dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.07]
                                  text-[11px] font-mono text-slate-500 dark:text-slate-300 max-h-32 overflow-auto">
                    {JSON.stringify(a.details, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── words ────────────────────────────────────────────────────────────── */

/**
 * The trend as a sentence, in whole events rather than a rate.
 *
 * This said "4 this week, usually 0.1". The 0.1 is a weekly mean over eight
 * weeks, so one event in that whole window renders as a tenth of an event, and
 * nobody can check that against what they remember. "1 in the 8 weeks before"
 * is the same fact counted in things that actually happened.
 */
function trendWords(k: {
  direction: string; thisWeek: number; baselineTotal: number; baselineWeeks: number; last: string;
}): string {
  const before = `${k.baselineTotal} in the ${k.baselineWeeks} weeks before`;
  switch (k.direction) {
    case "new": return "first time this has happened";
    case "up": return `${k.thisWeek} this week, ${before}`;
    case "down": return `${k.thisWeek} this week, ${before}`;
    case "steady": return `${k.thisWeek} this week, about usual`;
    // "none this week" on its own was the whole problem: it is the same
    // sentence whether the last one was yesterday or in March.
    default: return k.last ? `nothing this week, last ${shortDate(k.last)}` : "nothing this week";
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function spanWords(first: string, last: string): string {
  const mins = Math.round((Date.parse(last) - Date.parse(first)) / 60000);
  if (mins < 60) return `${Math.max(1, mins)} min`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/**
 * How long ago, roughly.
 *
 * The recent panel is scanned rather than read, and "2d" answers the only
 * question being asked of it. A full timestamp is in the record below.
 */
function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
