import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchRenovateDashboards, fetchDetectedDependencies, tickRenovateDashboard,
  type DashboardCategory, type DashboardItem, type RepoDashboard,
} from "../api/renovate";
import { Spinner, Note } from "../design";

/**
 * Renovate's dependency dashboard, organised by what is wrong rather than by
 * where it is.
 *
 * The first version listed repositories and put the states inside them, which
 * is the shape of the underlying data and the wrong shape for the question.
 * Nobody opens this asking "what is happening in payments-api". They open it
 * asking "what is broken", and then want every repository it is broken in, in
 * one place, to act on together.
 *
 * So the outline inverts that: one foldable section per state, repositories
 * nested inside, and everything closed by default except the states that need a
 * person. An organization with two thousand pending updates opens to about
 * fifteen lines.
 */

interface Style { label: string; verb: string; hint: string; dot: string; text: string; }

/** What each state is, what acting on it asks Renovate to do, and its colour. */
const STATES: Record<DashboardCategory, Style> = {
  errored: {
    label: "Errored", verb: "Retry",
    hint: "Renovate tried and failed. Usually a lockfile it could not resolve, or a registry it could not reach.",
    dot: "bg-rose-500", text: "text-rose-700 dark:text-rose-400",
  },
  blocked: {
    label: "Blocked", verb: "Recreate",
    hint: "Blocked by a closed or edited pull request. It will not come back on its own.",
    dot: "bg-orange-500", text: "text-orange-700 dark:text-orange-400",
  },
  "rate-limited": {
    label: "Rate-limited", verb: "Create now",
    hint: "Held back by Renovate's own limit on how many pull requests it opens at once.",
    dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400",
  },
  "pending-approval": {
    label: "Pending approval", verb: "Approve",
    hint: "Configured to wait for a person before the branch is created.",
    dot: "bg-violet-500", text: "text-violet-700 dark:text-violet-400",
  },
  "pr-approval-required": {
    label: "Pull request approval", verb: "Approve",
    hint: "The branch exists. The pull request is waiting on approval.",
    dot: "bg-violet-400", text: "text-violet-700 dark:text-violet-400",
  },
  "group-size-not-met": {
    label: "Group not full", verb: "Create anyway",
    hint: "Waiting for more updates before the group is worth raising.",
    dot: "bg-sky-500", text: "text-sky-700 dark:text-sky-400",
  },
  "pending-checks": {
    label: "Pending checks", verb: "Unpend",
    hint: "Waiting on status checks, or on an automerge that has not happened.",
    dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300",
  },
  "awaiting-schedule": {
    label: "Awaiting schedule", verb: "Run now",
    hint: "Queued until its schedule window opens.",
    dot: "bg-slate-400", text: "text-slate-600 dark:text-slate-300",
  },
  other: {
    label: "Other branches", verb: "Request",
    hint: "Branches Renovate is tracking that fit none of the other states.",
    dot: "bg-slate-300", text: "text-slate-600 dark:text-slate-300",
  },
  open: {
    label: "Already open", verb: "Rebase",
    hint: "Already raised as a pull request. The Pull requests view lists these in full.",
    dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400",
  },
};

/**
 * Worst first, and the first three open by default.
 *
 * Everything below them is Renovate working as intended, and opening all ten
 * would put two thousand lines in front of somebody who came to look at
 * fourteen.
 */
const ORDER: DashboardCategory[] = [
  "errored", "blocked", "rate-limited", "pending-approval", "pr-approval-required",
  "group-size-not-met", "pending-checks", "awaiting-schedule", "other", "open",
];
const OPEN_BY_DEFAULT: DashboardCategory[] = ["errored", "blocked", "rate-limited"];

const BULK_LABEL: Record<string, string> = {
  "create-all-rate-limited-prs": "Create all rate-limited",
  "approve-all-pending-prs": "Approve all pending",
  "create-all-awaiting-schedule-prs": "Run all scheduled",
  "rebase-all-open-prs": "Rebase all open",
  "create-config-migration-pr": "Open config migration",
  "manual job": "Run Renovate now",
};

/** A row's disclosure triangle, rotated rather than swapped. */
function Caret({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true"
      className={`w-2.5 h-2.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}>
      <path d="M4 2l5 4-5 4z" fill="currentColor" />
    </svg>
  );
}

/** The inventory for one repository, fetched only when its row is opened. */
function Inventory({ repo, issueNumber, query }: {
  repo: string; issueNumber: number; query: string;
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["renovate", "detected", repo, issueNumber],
    queryFn: () => fetchDetectedDependencies(repo, issueNumber),
    staleTime: 300_000,
  });

  if (isLoading) return <p className="py-2 pl-8 text-[12px] text-slate-400">Reading…</p>;
  if (isError) return <p className="py-2 pl-8 text-[12px] text-slate-400">Could not read it.</p>;

  const manifests = (data?.detected ?? [])
    .map(m => ({
      ...m,
      packages: query
        ? m.packages.filter(p => p.toLowerCase().includes(query))
        : m.packages,
    }))
    .filter(m => m.packages.length > 0);

  if (manifests.length === 0) {
    return (
      <p className="py-2 pl-8 text-[12px] text-slate-400">
        {query ? "Nothing here matches." : "No dependencies listed."}
      </p>
    );
  }

  return (
    <div className="pl-8 pr-3 pb-2">
      {manifests.map(m => (
        <div key={`${m.ecosystem} ${m.manifest}`} className="py-1.5">
          <p className="font-mono text-[11px] text-slate-400 dark:text-slate-500">
            {m.manifest}
            <span className="ml-2 not-italic opacity-70">{m.ecosystem}</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
            {m.packages.map(pkg => (
              <span key={pkg} className="font-mono text-[11.5px] text-slate-600 dark:text-slate-300">
                {pkg}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RenovateDashboardPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["renovate", "dashboards"],
    queryFn: fetchRenovateDashboards,
    staleTime: 120_000,
  });

  const [raw, setRaw] = useState("");
  /**
   * What has been flipped from its default, rather than what is open.
   *
   * Sections have different defaults, the first three open and the rest shut,
   * and repositories default to open inside an open section. Storing "flipped"
   * rather than "open" means one rule reads both: open is the default, unless
   * somebody has flipped it.
   */
  const [flipped, setFlipped] = useState<Set<string>>(new Set());
  const [openInventory, setOpenInventory] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  if (isLoading) return <Spinner />;
  if (error) return <Note intent="danger">Could not read the Renovate dashboards.</Note>;
  if (!data) return null;

  if (data.unknownBot) {
    return (
      <Note intent="warn">
        GitHub does not recognise <code>{data.bot}</code>. A self-hosted Renovate raises its
        issues as a GitHub App, whose login carries a <code>[bot]</code> suffix that GitHub's
        own pages hide. Correct the name in the Pull requests view.
      </Note>
    );
  }
  if (!data.configured) {
    return <Note intent="info">No Renovate bot account is named. Set one in the Pull requests view.</Note>;
  }

  const dashboards = data.dashboards ?? [];
  if (dashboards.length === 0) {
    return (
      <Note intent="info">
        Nothing {data.bot} has opened parses as a Dependency Dashboard. Renovate only keeps
        one where its config sets <code>dependencyDashboard</code> to true, or extends the{" "}
        <code>:dependencyDashboard</code> preset. Without it none of this is written down.
      </Note>
    );
  }

  const query = raw.trim().toLowerCase();
  const hit = (d: RepoDashboard, i: DashboardItem) =>
    !query || `${d.repo} ${i.title} ${i.branch}`.toLowerCase().includes(query);

  /**
   * State, then repository, then item.
   *
   * Built here rather than by filtering in the render, so a state whose every
   * item was filtered out disappears entirely rather than showing a heading
   * above nothing.
   */
  const grouped = ORDER.map(state => {
    const repos = dashboards
      .map(d => ({ d, items: d.items.filter(i => i.category === state && hit(d, i)) }))
      .filter(x => x.items.length > 0);
    return { state, repos, count: repos.reduce((n, r) => n + r.items.length, 0) };
  }).filter(g => g.count > 0);

  const total = grouped.reduce((n, g) => n + g.count, 0);

  /** Repositories whose inventory matches, so search reaches it too. */
  const inventoryRepos = dashboards.filter(d => d.detectedPackages > 0);

  const toggle = (set: Set<string>, key: string, apply: (s: Set<string>) => void) => {
    const next = new Set(set);
    next.has(key) ? next.delete(key) : next.add(key);
    apply(next);
  };

  const act = async (d: RepoDashboard, marker: string, what: string) => {
    setBusy(`${d.repo}|${marker}`);
    setNotice(null);
    try {
      const result = await tickRenovateDashboard(d.repo, d.issueNumber, marker);
      setNotice(result.ticked
        ? { ok: true, msg: `${what} requested on ${d.repo}. Renovate acts at its next run.` }
        : { ok: false, msg: result.reason ?? "Nothing to do." });
      qc.invalidateQueries({ queryKey: ["renovate", "dashboards"] });
    } catch (e: any) {
      setNotice({ ok: false, msg: e?.message ?? "Could not ask Renovate." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-white/10 overflow-hidden
                    bg-white dark:bg-[#151a23]">

      {/* One bar: what this is, how old it is, and the search. */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-white/10
                      flex items-center gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-slate-900 dark:text-white">
            {total.toLocaleString()} pending across {dashboards.length}{" "}
            {dashboards.length === 1 ? "repository" : "repositories"}
          </p>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums">
            {data.computedAt
              ? <>read {new Date(data.computedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  {data.refreshing && " · refreshing"}</>
              : "read just now"}
            {data.unparsed ? ` · ${data.unparsed} bot issues were not dashboards` : ""}
          </p>
        </div>
        <input
          value={raw} onChange={e => setRaw(e.target.value)}
          placeholder="Filter by repository, update or package…"
          className="w-full sm:w-72 px-3 py-1.5 text-[12.5px] rounded-lg
                     bg-slate-50 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10
                     text-slate-700 dark:text-slate-100 placeholder:text-slate-400
                     focus:outline-none focus:ring-2 focus:ring-slate-900/10 dark:focus:ring-white/20" />
      </div>

      {notice && (
        <div className={`px-4 py-2 text-[12px] border-b border-slate-200 dark:border-white/10 ${
          notice.ok
            ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/10"
            : "text-amber-800 dark:text-amber-300 bg-amber-50/60 dark:bg-amber-500/10"}`}>
          {notice.msg}
        </div>
      )}

      {/* ── the outline ─────────────────────────────────────────────────── */}
      {grouped.length === 0 && (
        <p className="px-4 py-6 text-[13px] text-slate-400 dark:text-slate-500">
          {query ? "Nothing matches that." : "Renovate has nothing pending anywhere."}
        </p>
      )}

      {grouped.map(({ state, repos, count }) => {
        const st = STATES[state];
        // Searching opens everything: a shut section hiding the only match is a
        // search that reports nothing found.
        const open = query
          ? true
          : OPEN_BY_DEFAULT.includes(state) !== flipped.has(`state:${state}`);

        return (
          <div key={state} className="border-b border-slate-100 dark:border-white/[0.06] last:border-0">
            <button
              onClick={() => toggle(flipped, `state:${state}`, setFlipped)}
              aria-expanded={open}
              title={st.hint}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left
                         hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
              <span className="text-slate-400"><Caret open={open} /></span>
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
              <span className={`text-[13px] font-bold ${st.text}`}>{st.label}</span>
              <span className="ml-auto text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
                {count}
              </span>
            </button>

            {open && repos.map(({ d, items }) => {
              const key = `${state}|${d.repo}`;
              const repoOpen = query ? true : !flipped.has(`repo:${key}`);
              return (
                <div key={key}>
                  <button onClick={() => toggle(flipped, `repo:${key}`, setFlipped)}
                    aria-expanded={repoOpen}
                    className="w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-left
                               hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
                    <span className="text-slate-300 dark:text-slate-600"><Caret open={repoOpen} /></span>
                    <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                      {d.repo}
                    </span>
                    <span className="text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                      {items.length}
                    </span>
                    <a href={d.url} target="_blank" rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="ml-auto text-[11px] text-slate-400 hover:text-slate-700
                                 dark:hover:text-slate-200 underline underline-offset-2">
                      #{d.issueNumber}
                    </a>
                  </button>

                  {repoOpen && items.map(item => {
                    const marker = `${item.action}-branch=${item.branch}`;
                    const running = busy === `${d.repo}|${marker}`;
                    return (
                      <div key={marker}
                        className="flex items-center gap-3 pl-[4.5rem] pr-4 py-1.5
                                   border-l-2 border-transparent hover:bg-slate-50 dark:hover:bg-white/[0.03]">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] text-slate-700 dark:text-slate-200 truncate">
                            {item.title}
                          </span>
                          <span className="block font-mono text-[10.5px] text-slate-400 dark:text-slate-500 truncate">
                            {item.branch}
                          </span>
                        </span>
                        {item.checked ? (
                          <span className="shrink-0 text-[11px] text-slate-400 dark:text-slate-500">requested</span>
                        ) : (
                          <button disabled={busy !== null} onClick={() => act(d, marker, st.verb)}
                            className="shrink-0 text-[11px] font-bold px-2 py-0.5 rounded
                                       text-slate-600 dark:text-slate-300
                                       hover:bg-slate-200 dark:hover:bg-white/10
                                       disabled:opacity-40 transition-colors">
                            {running ? "…" : st.verb}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}

      {/* ── the inventory, its own foldable section ─────────────────────── */}
      {inventoryRepos.length > 0 && (
        <div className="border-t border-slate-200 dark:border-white/10">
          <button onClick={() => toggle(flipped, "inv", setFlipped)}
            aria-expanded={flipped.has("inv")}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left
                       hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
            <span className="text-slate-400"><Caret open={flipped.has("inv")} /></span>
            <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-slate-300 dark:bg-slate-600" />
            <span className="text-[13px] font-bold text-slate-600 dark:text-slate-300">
              Detected dependencies
            </span>
            <span className="ml-auto text-[12px] tabular-nums text-slate-400 dark:text-slate-500">
              {inventoryRepos.reduce((n, d) => n + d.detectedPackages, 0).toLocaleString()}
            </span>
          </button>

          {flipped.has("inv") && inventoryRepos.map(d => {
            const shown = openInventory.has(d.repo);
            return (
              <div key={`inv-${d.repo}`}>
                <button onClick={() => toggle(openInventory, d.repo, setOpenInventory)}
                  aria-expanded={shown}
                  className="w-full flex items-center gap-2 pl-9 pr-4 py-1.5 text-left
                             hover:bg-slate-50 dark:hover:bg-white/[0.03] transition-colors">
                  <span className="text-slate-300 dark:text-slate-600"><Caret open={shown} /></span>
                  <span className="text-[12.5px] font-semibold text-slate-700 dark:text-slate-200 truncate">
                    {d.repo}
                  </span>
                  <span className="ml-auto text-[11px] tabular-nums text-slate-400 dark:text-slate-500">
                    {d.detectedPackages} in {d.detectedManifests}
                  </span>
                </button>
                {/* Fetched per repository, on expansion. Across an organization
                    this is megabytes and almost nobody opens it. */}
                {shown && <Inventory repo={d.repo} issueNumber={d.issueNumber} query={query} />}
              </div>
            );
          })}
        </div>
      )}

      {/* ── whole-dashboard actions, last ──────────────────────────────── */}
      {dashboards.some(d => d.bulk.some(b => !b.checked && BULK_LABEL[b.marker])) && (
        <div className="px-4 py-3 border-t border-slate-200 dark:border-white/10
                        bg-slate-50/60 dark:bg-white/[0.02]">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
            Whole repository
          </p>
          <div className="flex flex-wrap gap-1.5">
            {dashboards.flatMap(d =>
              d.bulk.filter(b => !b.checked && BULK_LABEL[b.marker]).map(b => (
                <button key={`${d.repo}|${b.marker}`}
                  disabled={busy !== null}
                  onClick={() => act(d, b.marker, BULK_LABEL[b.marker])}
                  className="text-[11px] px-2 py-1 rounded-md border border-slate-200 dark:border-white/10
                             text-slate-600 dark:text-slate-300 hover:border-slate-400
                             dark:hover:border-white/30 disabled:opacity-40 transition-colors">
                  <span className="font-semibold">{d.repo}</span>
                  <span className="mx-1 opacity-40">·</span>
                  {BULK_LABEL[b.marker]}
                </button>
              )))}
          </div>
        </div>
      )}

      <p className="px-4 py-2.5 text-[11px] text-slate-400 dark:text-slate-500
                    border-t border-slate-100 dark:border-white/[0.06]">
        Acting here ticks the checkbox on the dashboard issue, which is how a self-hosted
        Renovate is instructed. It runs on its own schedule, so a request made now appears
        whenever the bot next runs.
      </p>
    </div>
  );
}
