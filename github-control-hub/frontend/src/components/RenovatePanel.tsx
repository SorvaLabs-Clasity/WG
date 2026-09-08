import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchRenovate, fetchRenovateDashboards, fetchDetectedDependencies,
  tickRenovateDashboard, setRenovateBot,
  type DashboardCategory, type RenovatePr, type RepoDashboard,
} from "../api/renovate";
import { usePermissions } from "../hooks/usePermissions";
import { Spinner, Note } from "../design";

/**
 * Everything Renovate is doing, on one screen.
 *
 * This replaces two views that were the same subject split down the middle: the
 * pull requests it had raised, and the dashboard listing what it would raise.
 * Nobody wants half of that. An update Renovate errored on and an update it
 * raised last week are the same question asked at two moments, and answering
 * them in separate tabs meant checking both to learn where a repository stood.
 *
 * They are joined by branch, which is the key Renovate itself uses: a dashboard
 * row under "Open" and the pull request it refers to carry the same
 * `headRefName`, so one row can carry both the check status and the action.
 *
 * The previous attempt at this was an outline, and its fault was that
 * everything in it had the same weight. A tree of identical grey rows makes the
 * fourteen things that are broken exactly as prominent as the two thousand that
 * are fine. So the counts lead, in a size that cannot be missed, and the list
 * below answers whichever one was pressed.
 */

/**
 * The five states somebody actually acts on.
 *
 * Not Renovate's ten, which are its internal vocabulary: "group size not met"
 * and "awaiting schedule" are both just "held back, nothing for you to do", and
 * separating them on the summary buys precision nobody wanted at the cost of
 * the two that matter being one fifth as prominent.
 */
type Lens = "ready" | "failing" | "errored" | "waiting" | "held";

const LENSES: { id: Lens; label: string; sub: string; ring: string; text: string; dot: string }[] = [
  {
    id: "ready", label: "Ready to merge", sub: "checks passed, nothing blocking",
    ring: "ring-emerald-500/30 hover:ring-emerald-500/60", text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  {
    id: "failing", label: "Failing", sub: "checks failed, or conflicts",
    ring: "ring-rose-500/30 hover:ring-rose-500/60", text: "text-rose-600 dark:text-rose-400",
    dot: "bg-rose-500",
  },
  {
    id: "errored", label: "Errored", sub: "Renovate could not raise it",
    ring: "ring-orange-500/30 hover:ring-orange-500/60", text: "text-orange-600 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  {
    id: "waiting", label: "Waiting on you", sub: "needs an approval",
    ring: "ring-violet-500/30 hover:ring-violet-500/60", text: "text-violet-600 dark:text-violet-400",
    dot: "bg-violet-500",
  },
  {
    id: "held", label: "Held back", sub: "rate limit or schedule",
    ring: "ring-slate-400/30 hover:ring-slate-400/60", text: "text-slate-500 dark:text-slate-400",
    dot: "bg-slate-400",
  },
];

/** Which lens a dashboard state belongs to. */
const LENS_OF: Record<DashboardCategory, Lens | null> = {
  errored: "errored",
  blocked: "errored",
  "pending-approval": "waiting",
  "pr-approval-required": "waiting",
  "rate-limited": "held",
  "awaiting-schedule": "held",
  "group-size-not-met": "held",
  "pending-checks": "held",
  other: "held",
  // Open rows are covered by the pull request they refer to, which knows
  // whether it is ready or failing. Counting them here as well would count the
  // same update twice.
  open: null,
};

/** What pressing the action on a dashboard row asks Renovate to do. */
const VERB: Record<DashboardCategory, string> = {
  errored: "Retry", blocked: "Recreate", "rate-limited": "Create now",
  "pending-approval": "Approve", "pr-approval-required": "Approve",
  "group-size-not-met": "Create anyway", "awaiting-schedule": "Run now",
  "pending-checks": "Unpend", other: "Request", open: "Rebase",
};

const BULK_LABEL: Record<string, string> = {
  "create-all-rate-limited-prs": "Create all rate-limited",
  "approve-all-pending-prs": "Approve all pending",
  "create-all-awaiting-schedule-prs": "Run all scheduled",
  "rebase-all-open-prs": "Rebase all open",
  "create-config-migration-pr": "Open config migration",
  "manual job": "Run Renovate now",
};

/** One update, whether it exists as a pull request yet or not. */
interface Row {
  repo: string;
  branch: string;
  title: string;
  lens: Lens;
  /** The pull request, where one has been raised. */
  pr?: RenovatePr;
  /** The dashboard checkbox that acts on it, where there is one. */
  marker?: string;
  verb?: string;
  requested?: boolean;
  issueNumber?: number;
}

function Caret({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true"
      className={`w-2.5 h-2.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
      <path d="M4 2l5 4-5 4z" fill="currentColor" />
    </svg>
  );
}

/** The inventory for one repository, fetched only when opened. */
function Inventory({ repo, issueNumber, query }: { repo: string; issueNumber: number; query: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["renovate", "detected", repo, issueNumber],
    queryFn: () => fetchDetectedDependencies(repo, issueNumber),
    staleTime: 300_000,
  });

  if (isLoading) return <p className="px-4 py-2 text-[12px] text-slate-400">Reading…</p>;

  const manifests = (data?.detected ?? [])
    .map(m => ({ ...m, packages: query ? m.packages.filter(p => p.toLowerCase().includes(query)) : m.packages }))
    .filter(m => m.packages.length > 0);

  if (manifests.length === 0) {
    return <p className="px-4 py-2 text-[12px] text-slate-400">
      {query ? "Nothing here matches." : "No dependencies listed."}
    </p>;
  }

  return (
    <div className="px-4 py-2 space-y-2">
      {manifests.map(m => (
        <div key={`${m.ecosystem} ${m.manifest}`}>
          <p className="font-mono text-[11px] text-slate-400 dark:text-slate-500">{m.manifest}</p>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {m.packages.map(p => (
              <span key={p} className="font-mono text-[11.5px] text-slate-600 dark:text-slate-300">{p}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RenovatePanel() {
  const qc = useQueryClient();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;

  const prs = useQuery({
    queryKey: ["renovate", "details"],
    queryFn: () => fetchRenovate(true),
    staleTime: 120_000,
  });
  const dash = useQuery({
    queryKey: ["renovate", "dashboards"],
    queryFn: fetchRenovateDashboards,
    staleTime: 120_000,
  });

  const [lens, setLens] = useState<Lens | null>(null);
  const [raw, setRaw] = useState("");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [invOpen, setInvOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);
  const [botDraft, setBotDraft] = useState("");
  const [editing, setEditing] = useState(false);

  const saveBot = useMutation({
    mutationFn: (bot: string) => setRenovateBot(bot),
    onSuccess: () => { setEditing(false); qc.invalidateQueries({ queryKey: ["renovate"] }); },
  });

  if (prs.isLoading || dash.isLoading) return <Spinner />;
  if (prs.error && dash.error) return <Note intent="danger">Could not read anything from Renovate.</Note>;

  const bot = prs.data?.bot ?? dash.data?.bot ?? null;

  if (prs.data && !prs.data.configured) {
    return (
      <div className="rounded-2xl border border-slate-200 dark:border-white/10 p-6
                      bg-white dark:bg-[#151a23]">
        <h3 className="text-[15px] font-bold text-slate-900 dark:text-white">Renovate</h3>
        <p className="text-[13px] text-slate-500 dark:text-slate-400 mt-1.5 max-w-2xl leading-relaxed">
          A self-hosted Renovate raises its pull requests and keeps its dashboard as a GitHub
          App, and its authorship is the only way to find them. Type the name shown beside one
          of its pull requests; the <code>[bot]</code> suffix an App's login carries is added
          for you.
        </p>
        {isAdmin ? (
          <div className="mt-4 flex gap-2 max-w-md">
            <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
              placeholder="e.g. my-renovate"
              className="flex-1 px-3 py-2 text-sm rounded-lg bg-slate-50 dark:bg-white/[0.06]
                         border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-100" />
            <button onClick={() => saveBot.mutate(botDraft)} disabled={!botDraft.trim()}
              className="px-4 py-2 text-sm font-bold rounded-lg bg-slate-900 dark:bg-white
                         text-white dark:text-slate-900 disabled:opacity-40">Save</button>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-amber-700 dark:text-amber-400">
            An organization admin has to set the bot account.
          </p>
        )}
      </div>
    );
  }

  if (dash.data?.unknownBot || prs.data?.unknownBot) {
    return (
      <Note intent="warn">
        GitHub does not recognise <code>{bot}</code>. A self-hosted Renovate raises its work as
        a GitHub App, whose login carries a <code>[bot]</code> suffix that GitHub's own pages
        hide, so the name shown beside a pull request is not the name search wants.
        {isAdmin && <> Correct it: <button onClick={() => { setBotDraft(bot ?? ""); setEditing(true); }}
          className="font-bold underline underline-offset-2">change the bot name</button>.</>}
      </Note>
    );
  }

  const dashboards: RepoDashboard[] = dash.data?.dashboards ?? [];
  const allPrs: RenovatePr[] = prs.data?.prs ?? [];
  const openPrs = allPrs.filter(p => p.state === "open");

  /**
   * One row per update, joining the two sources on the branch.
   *
   * A dashboard row under "Open" and the pull request it refers to are the same
   * update: Renovate writes the branch into both. Joining them is what lets one
   * row carry the check status *and* the rebase action, instead of the two
   * living on separate screens.
   */
  const byBranch = new Map<string, RenovatePr>();
  for (const pr of openPrs) if (pr.headRefName) byBranch.set(`${pr.repo}|${pr.headRefName}`, pr);

  const rows: Row[] = [];
  const claimed = new Set<string>();

  for (const d of dashboards) {
    for (const item of d.items) {
      const key = `${d.repo}|${item.branch}`;
      const pr = byBranch.get(key);
      const lens = pr
        ? (pr.readiness === "ready" ? "ready" : pr.readiness === "failing" || pr.readiness === "conflicting"
          ? "failing" : "held")
        : LENS_OF[item.category];
      if (!lens) continue;
      if (pr) claimed.add(key);

      rows.push({
        repo: d.repo, branch: item.branch, title: item.title, lens,
        pr,
        marker: `${item.action}-branch=${item.branch}`,
        verb: VERB[item.category],
        requested: item.checked,
        issueNumber: d.issueNumber,
      });
    }
  }

  // Pull requests on repositories with no dashboard, or that the dashboard did
  // not list. Dropping them would make a repository without a dashboard look
  // like a repository with no Renovate activity.
  for (const pr of openPrs) {
    const key = `${pr.repo}|${pr.headRefName ?? ""}`;
    if (claimed.has(key)) continue;
    rows.push({
      repo: pr.repo, branch: pr.headRefName ?? "", title: pr.title,
      lens: pr.readiness === "ready" ? "ready"
        : pr.readiness === "failing" || pr.readiness === "conflicting" ? "failing" : "held",
      pr,
    });
  }

  const counts = Object.fromEntries(
    LENSES.map(l => [l.id, rows.filter(r => r.lens === l.id).length])) as Record<Lens, number>;

  const query = raw.trim().toLowerCase();
  const visible = rows.filter(r =>
    (!lens || r.lens === lens)
    && (!query || `${r.repo} ${r.title} ${r.branch}`.toLowerCase().includes(query)));

  /** Grouped by repository, worst lens first inside each. */
  const order: Lens[] = ["errored", "failing", "waiting", "ready", "held"];
  const groups = [...new Set(visible.map(r => r.repo))].sort().map(repo => ({
    repo,
    rows: visible.filter(r => r.repo === repo)
      .sort((a, b) => order.indexOf(a.lens) - order.indexOf(b.lens)),
    dashboard: dashboards.find(d => d.repo === repo),
  }));

  const act = async (repo: string, issueNumber: number, marker: string, what: string) => {
    setBusy(`${repo}|${marker}`); setNotice(null);
    try {
      const r = await tickRenovateDashboard(repo, issueNumber, marker);
      setNotice(r.ticked
        ? { ok: true, msg: `${what} requested on ${repo}. Renovate acts at its next run.` }
        : { ok: false, msg: r.reason ?? "Nothing to do." });
      qc.invalidateQueries({ queryKey: ["renovate", "dashboards"] });
    } catch (e: any) {
      setNotice({ ok: false, msg: e?.message ?? "Could not ask Renovate." });
    } finally { setBusy(null); }
  };

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  const stamp = dash.data?.computedAt ?? prs.data?.computedAt;

  return (
    <div className="space-y-4">
      {/* ── the numbers, first and large ───────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {LENSES.map(l => {
          const active = lens === l.id;
          const n = counts[l.id];
          return (
            <button key={l.id} onClick={() => setLens(active ? null : l.id)}
              className={`text-left rounded-2xl px-4 py-3.5 ring-1 transition-all
                          bg-white dark:bg-[#151a23]
                          ${active ? "ring-2 ring-slate-900 dark:ring-white" : `ring-inset ${l.ring}`}
                          ${n === 0 ? "opacity-45" : ""}`}>
              <div className={`text-[30px] font-black leading-none tabular-nums tracking-tight
                               ${n === 0 ? "text-slate-300 dark:text-slate-600" : l.text}`}>
                {n}
              </div>
              <div className="mt-1.5 text-[12.5px] font-bold text-slate-800 dark:text-slate-100">
                {l.label}
              </div>
              <div className="text-[11px] text-slate-400 dark:text-slate-500 leading-tight">
                {l.sub}
              </div>
            </button>
          );
        })}
      </div>

      {/* ── who and when, small ────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap text-[11.5px] text-slate-400 dark:text-slate-500">
        <span>
          Raised by <code className="px-1 rounded bg-black/5 dark:bg-white/10">{bot}</code>
          {isAdmin && (
            <> · <button onClick={() => { setBotDraft(bot ?? ""); setEditing(true); }}
              className="underline underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200">
              change</button></>
          )}
        </span>
        {stamp && (
          <span className="tabular-nums">
            read {new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            {(dash.data?.refreshing || prs.data?.refreshing) && " · refreshing"}
          </span>
        )}
        {dash.data?.unparsed ? <span>{dash.data.unparsed} bot issues were not dashboards</span> : null}
        {dashboards.length === 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            No dependency dashboards found, so only pull requests are listed. Renovate keeps one
            per repository where its config sets dependencyDashboard.
          </span>
        )}
      </div>

      {editing && isAdmin && (
        <div className="flex gap-2 max-w-md">
          <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
            className="flex-1 px-3 py-2 text-sm rounded-lg bg-slate-50 dark:bg-white/[0.06]
                       border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-100" />
          <button onClick={() => saveBot.mutate(botDraft)}
            className="px-4 py-2 text-sm font-bold rounded-lg bg-slate-900 dark:bg-white
                       text-white dark:text-slate-900">Save</button>
          <button onClick={() => setEditing(false)}
            className="px-3 py-2 text-sm text-slate-500">Cancel</button>
        </div>
      )}

      {notice && <Note intent={notice.ok ? "good" : "warn"}>{notice.msg}</Note>}

      <input value={raw} onChange={e => setRaw(e.target.value)}
        placeholder="Filter by repository, update or branch…"
        className="w-full px-3.5 py-2.5 text-sm rounded-xl bg-white dark:bg-white/[0.06]
                   border border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-100
                   placeholder:text-slate-400 focus:outline-none focus:ring-2
                   focus:ring-slate-900/10 dark:focus:ring-white/20" />

      {/* ── the list ───────────────────────────────────────────────────── */}
      {groups.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-slate-400 dark:text-slate-500">
          {lens || query ? "Nothing matches that." : "Renovate has nothing outstanding."}
        </p>
      ) : (
        <div className="rounded-2xl border border-slate-200 dark:border-white/10 overflow-hidden
                        bg-white dark:bg-[#151a23]">
          {groups.map(({ repo, rows: group, dashboard }) => {
            const open = query ? true : !shut.has(repo);
            return (
              <div key={repo} className="border-b border-slate-100 dark:border-white/[0.06] last:border-0">
                <button onClick={() => toggle(shut, repo, setShut)} aria-expanded={open}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left
                             hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
                  <span className="text-slate-400"><Caret open={open} /></span>
                  <span className="text-[13px] font-bold text-slate-900 dark:text-white truncate">{repo}</span>
                  <span className="flex items-center gap-1">
                    {order.filter(l => group.some(r => r.lens === l)).map(l => (
                      <span key={l} className={`w-1.5 h-1.5 rounded-full ${LENSES.find(x => x.id === l)!.dot}`} />
                    ))}
                  </span>
                  <span className="ml-auto text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                    {group.length}
                  </span>
                </button>

                {open && group.map(r => {
                  const running = busy === `${r.repo}|${r.marker}`;
                  const style = LENSES.find(x => x.id === r.lens)!;
                  return (
                    <div key={`${r.repo}|${r.branch}|${r.title}`}
                      className="flex items-center gap-3 pl-4 pr-4 py-2 overflow-hidden
                                 hover:bg-slate-50 dark:hover:bg-white/[0.03]">
                      <span className={`w-1 self-stretch shrink-0 rounded-full ${style.dot}`} />

                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] text-slate-800 dark:text-slate-100 truncate">
                          {r.title}
                        </span>
                        <span className="block text-[11px] text-slate-400 dark:text-slate-500 truncate">
                          {r.pr ? (
                            <>
                              #{r.pr.number}
                              {r.pr.checks === "SUCCESS" && <span className="text-emerald-600 dark:text-emerald-400"> · checks passed</span>}
                              {(r.pr.checks === "FAILURE" || r.pr.checks === "ERROR") && <span className="text-rose-600 dark:text-rose-400"> · checks failed</span>}
                              {r.pr.checks === "PENDING" && " · checks running"}
                              {r.pr.mergeable === "CONFLICTING" && <span className="text-amber-600 dark:text-amber-400"> · conflicts</span>}
                              {r.pr.reviewDecision === "REVIEW_REQUIRED" && " · review needed"}
                              {r.pr.changedFiles !== undefined && ` · +${r.pr.additions ?? 0} −${r.pr.deletions ?? 0}`}
                              {` · ${r.pr.ageDays}d`}
                            </>
                          ) : (
                            <span className="font-mono">{r.branch}</span>
                          )}
                        </span>
                      </span>

                      {r.pr && (
                        <a href={r.pr.url} target="_blank" rel="noopener noreferrer"
                          className="shrink-0 text-[11.5px] font-bold px-2 py-1 rounded-lg
                                     text-slate-600 dark:text-slate-300
                                     hover:bg-slate-200 dark:hover:bg-white/10 transition-colors">
                          Open ↗
                        </a>
                      )}
                      {r.marker && r.issueNumber !== undefined && (
                        r.requested ? (
                          <span className="shrink-0 text-[11px] text-slate-400">requested</span>
                        ) : (
                          <button disabled={busy !== null}
                            onClick={() => act(r.repo, r.issueNumber!, r.marker!, r.verb!)}
                            className="shrink-0 text-[11.5px] font-bold px-2 py-1 rounded-lg
                                       ring-1 ring-inset ring-slate-200 dark:ring-white/15
                                       text-slate-700 dark:text-slate-200
                                       hover:ring-slate-400 dark:hover:ring-white/30
                                       disabled:opacity-40 transition-colors">
                            {running ? "…" : r.verb}
                          </button>
                        )
                      )}
                    </div>
                  );
                })}

                {/* This repository's whole-dashboard actions and inventory,
                    folded under it rather than in a section of their own. */}
                {open && dashboard && (
                  <div className="pl-4 pr-4 pb-2 flex items-center gap-1.5 flex-wrap">
                    {dashboard.bulk.filter(b => !b.checked && BULK_LABEL[b.marker]).map(b => (
                      <button key={b.marker} disabled={busy !== null}
                        onClick={() => act(repo, dashboard.issueNumber, b.marker, BULK_LABEL[b.marker])}
                        className="text-[11px] px-2 py-0.5 rounded-md ring-1 ring-inset
                                   ring-slate-200 dark:ring-white/10 text-slate-500 dark:text-slate-400
                                   hover:ring-slate-400 disabled:opacity-40 transition-colors">
                        {BULK_LABEL[b.marker]}
                      </button>
                    ))}
                    {dashboard.detectedPackages > 0 && (
                      <button onClick={() => toggle(invOpen, repo, setInvOpen)}
                        aria-expanded={invOpen.has(repo)}
                        className="text-[11px] px-2 py-0.5 rounded-md text-slate-400 dark:text-slate-500
                                   hover:text-slate-700 dark:hover:text-slate-200 inline-flex items-center gap-1">
                        <Caret open={invOpen.has(repo)} />
                        {dashboard.detectedPackages} dependencies
                      </button>
                    )}
                  </div>
                )}
                {open && dashboard && invOpen.has(repo) && (
                  <div className="border-t border-slate-100 dark:border-white/[0.06]">
                    <Inventory repo={repo} issueNumber={dashboard.issueNumber} query={query} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed">
        Actions here tick a checkbox on the repository's dashboard issue, which is how a
        self-hosted Renovate is instructed. It acts at its next run rather than immediately.
        Nothing here merges anything.
      </p>
    </div>
  );
}
