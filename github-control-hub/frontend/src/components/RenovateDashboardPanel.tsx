import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchRenovateDashboards, fetchDetectedDependencies, tickRenovateDashboard,
  type DashboardCategory, type DashboardItem, type RepoDashboard,
} from "../api/renovate";
import { SearchInput, Empty, Spinner, Note, SURFACE, TYPE, INTENT } from "../design";
import type { Intent } from "../design";

/**
 * What Renovate would do and has not.
 *
 * A self-hosted Renovate has no API and no web dashboard: it runs and exits.
 * The only place its state is written down is the Dependency Dashboard issue it
 * keeps in each repository, and everything in there is invisible from the pull
 * request list this app read before. A repository where Renovate errors on
 * every run looks exactly like one with nothing to do.
 *
 * So this leads with the categories nobody can otherwise see, errored and
 * rate-limited and awaiting approval, and puts the pull requests it has already
 * opened last. The other view already covers those.
 */

/** What each category is, and what pressing its button asks Renovate to do. */
const CATEGORY: Record<DashboardCategory, {
  label: string; intent: Intent; verb: string; hint: string;
}> = {
  errored: {
    label: "Errored", intent: "danger", verb: "Retry",
    hint: "Renovate tried and failed. Usually a lockfile it could not resolve, or a registry it could not reach.",
  },
  "rate-limited": {
    label: "Rate-limited", intent: "warn", verb: "Create now",
    hint: "Held back by Renovate's own limit on how many it opens at once.",
  },
  "pending-approval": {
    label: "Pending approval", intent: "info", verb: "Approve",
    hint: "Configured to wait for a person before the branch is created.",
  },
  "pr-approval-required": {
    label: "PR approval required", intent: "info", verb: "Approve PR",
    hint: "The branch exists; the pull request is waiting on approval.",
  },
  "group-size-not-met": {
    label: "Group not full", intent: "info", verb: "Create anyway",
    hint: "Waiting for more updates before the group is worth a pull request.",
  },
  "awaiting-schedule": {
    label: "Awaiting schedule", intent: "neutral", verb: "Run now",
    hint: "Queued until its schedule window opens.",
  },
  "pending-checks": {
    label: "Pending checks", intent: "neutral", verb: "Unpend",
    hint: "Waiting on status checks or an automerge that has not happened.",
  },
  blocked: {
    label: "Blocked", intent: "warn", verb: "Recreate",
    hint: "Blocked by a closed or edited pull request, and will not come back on its own.",
  },
  other: {
    label: "Other", intent: "neutral", verb: "Request",
    hint: "A branch Renovate is tracking that fits none of the other states.",
  },
  open: {
    label: "Open", intent: "good", verb: "Rebase",
    hint: "Already raised as a pull request. The Pull requests view lists these.",
  },
};

/** The order somebody would work through them: broken first, done last. */
const ORDER: DashboardCategory[] = [
  "errored", "blocked", "rate-limited", "pending-approval", "pr-approval-required",
  "group-size-not-met", "pending-checks", "awaiting-schedule", "other", "open",
];

/** The whole-dashboard checkboxes, in words. */
const BULK_LABEL: Record<string, string> = {
  "create-all-rate-limited-prs": "Create every rate-limited update",
  "approve-all-pending-prs": "Approve everything pending",
  "create-all-awaiting-schedule-prs": "Run everything awaiting schedule",
  "rebase-all-open-prs": "Rebase every open pull request",
  "create-config-migration-pr": "Open the config migration pull request",
  "manual job": "Ask Renovate to run on this repository now",
};

/**
 * The dependency inventory for one repository.
 *
 * Its own component so the fetch happens on expansion and belongs to the row
 * that caused it. Across an organization this is megabytes, and almost nobody
 * opens it.
 */
function DetectedDependencies({ repo, issueNumber }: { repo: string; issueNumber: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["renovate", "detected", repo, issueNumber],
    queryFn: () => fetchDetectedDependencies(repo, issueNumber),
    staleTime: 300_000,
  });

  if (isLoading) return <p className="text-[12px] text-slate-400 dark:text-slate-500">Reading the dashboard…</p>;
  if (isError) return <p className="text-[12px] text-slate-400 dark:text-slate-500">Could not read it.</p>;
  if (!data?.detected?.length) {
    return (
      <p className="text-[12px] text-slate-400 dark:text-slate-500">
        This dashboard lists no detected dependencies.
      </p>
    );
  }

  return (
    <div className="grid gap-2.5">
      {data.detected.map(m => (
        <div key={`${m.ecosystem} ${m.manifest}`}>
          <p className="text-[11.5px] font-bold text-slate-700 dark:text-slate-200">
            <span className="font-mono">{m.manifest}</span>
            <span className="ml-1.5 font-normal text-slate-400 dark:text-slate-500">{m.ecosystem}</span>
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {m.packages.map(pkg => (
              <span key={pkg}
                className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.07]
                           text-slate-600 dark:text-slate-300">
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

  const [only, setOnly] = useState<DashboardCategory | null>(null);
  const [search, setSearch] = useState("");
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null);

  if (isLoading) return <Spinner />;
  if (error) return <Note intent="danger">Could not read the Renovate dashboards.</Note>;
  if (!data) return null;

  if (!data.configured) {
    return (
      <Note intent="info">
        No Renovate bot account is named, so there is nothing to look for. Set one in the
        Pull requests view.
      </Note>
    );
  }

  const dashboards = data.dashboards ?? [];

  if (dashboards.length === 0) {
    return (
      <Empty
        title="No dependency dashboards found"
        body={
          `Nothing that ${data.bot} has opened parses as a Dependency Dashboard. `
          + "It is off by default: Renovate only keeps one where its config sets "
          + "dependencyDashboard to true, or extends the :dependencyDashboard preset. "
          + "Without it, none of this is written down anywhere."
        }
      />
    );
  }

  /** Counted over every dashboard, which is the summary read before filtering. */
  const tally = ORDER.map(category => ({
    category,
    count: dashboards.reduce(
      (n, d) => n + d.items.filter(i => i.category === category).length, 0),
  })).filter(t => t.count > 0);

  const matches = (d: RepoDashboard, item: DashboardItem) =>
    (!only || item.category === only)
    && (!search.trim()
      || `${d.repo} ${item.title} ${item.branch}`.toLowerCase().includes(search.trim().toLowerCase()));

  const shown = dashboards
    .map(d => ({ dashboard: d, items: d.items.filter(i => matches(d, i)) }))
    .filter(x => x.items.length > 0 || (!only && !search.trim()));

  const act = async (d: RepoDashboard, marker: string, what: string) => {
    setBusy(`${d.repo} ${marker}`);
    setNotice(null);
    try {
      const result = await tickRenovateDashboard(d.repo, d.issueNumber, marker);
      setNotice(result.ticked
        ? { ok: true, msg: `${what} requested on ${d.repo}. Renovate acts on it at its next run.` }
        : { ok: false, msg: result.reason ?? "Nothing to do." });
      qc.invalidateQueries({ queryKey: ["renovate", "dashboards"] });
    } catch (e: any) {
      setNotice({ ok: false, msg: e?.message ?? "Could not ask Renovate." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 max-w-[85ch] leading-relaxed`}>
          What Renovate would do and has not. A self-hosted bot has no API and no web
          dashboard, so this reads the Dependency Dashboard issue it keeps in each
          repository. Everything below is invisible from the pull request list.
        </p>
      </div>

      {/* Broken first. Filters rather than a dashboard, on one line. */}
      {tally.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setOnly(null)}
            className={`text-[12px] font-bold rounded-lg px-2.5 py-1.5 border transition-colors ${
              only === null
                ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent"
                : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/25"
            }`}>
            All <span className="tabular-nums opacity-70">{tally.reduce((n, t) => n + t.count, 0)}</span>
          </button>
          {tally.map(({ category, count }) => {
            const c = CATEGORY[category];
            const active = only === category;
            return (
              <button key={category} onClick={() => setOnly(active ? null : category)}
                title={c.hint}
                className={`inline-flex items-center gap-1.5 text-[12px] font-bold rounded-lg px-2.5 py-1.5 border transition-colors ${
                  active
                    ? "bg-slate-900 dark:bg-white text-white dark:text-slate-900 border-transparent"
                    : "border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-slate-300 dark:hover:border-white/25"
                }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${INTENT[c.intent].mark}`} aria-hidden="true" />
                {c.label} <span className="tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Not an error, and not noise: it is how somebody notices the parse has
          stopped recognising dashboards after a Renovate upgrade, which would
          otherwise look like every repository having nothing pending. */}
      {data.unparsed > 0 && (
        <Note intent="info">
          {data.unparsed} other issue{data.unparsed === 1 ? "" : "s"} from {data.bot}{" "}
          {data.unparsed === 1 ? "is" : "are"} not a dependency dashboard, so{" "}
          {data.unparsed === 1 ? "it was" : "they were"} skipped.
        </Note>
      )}

      {notice && <Note intent={notice.ok ? "good" : "warn"}>{notice.msg}</Note>}

      <SearchInput value={search} onChange={setSearch}
        placeholder="Search repository, update or branch…" />

      {shown.length === 0 ? (
        <Empty title="Nothing matches"
          body={only ? `No repository has anything ${CATEGORY[only].label.toLowerCase()}.` : "No updates match."} />
      ) : (
        <div className="grid gap-2">
          {shown.map(({ dashboard: d, items }) => {
            const isOpen = opened.has(d.repo);
            return (
              <div key={d.repo} className={`${SURFACE.card} px-4 py-3.5`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-900 dark:text-slate-100">{d.repo}</span>
                      <a href={d.url} target="_blank" rel="noopener noreferrer"
                        className="text-[11.5px] text-slate-400 dark:text-slate-500 underline underline-offset-2">
                        dashboard #{d.issueNumber}
                      </a>
                    </div>
                    {d.detectedPackages > 0 && (
                      <button onClick={() => setOpened(prev => {
                        const next = new Set(prev);
                        next.has(d.repo) ? next.delete(d.repo) : next.add(d.repo);
                        return next;
                      })}
                        aria-expanded={isOpen}
                        className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] font-bold
                                   text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100
                                   transition-colors">
                        <i className={`ph-bold ph-caret-down text-[9px] transition-transform ${isOpen ? "rotate-180" : ""}`}
                          aria-hidden="true" />
                        {d.detectedPackages} dependencies across {d.detectedManifests}{" "}
                        manifest{d.detectedManifests === 1 ? "" : "s"}
                      </button>
                    )}
                  </div>

                  {/* The whole-dashboard boxes, where Renovate wrote any. */}
                  <div className="shrink-0 flex flex-wrap gap-1.5 justify-end">
                    {d.bulk.filter(b => !b.checked && BULK_LABEL[b.marker]).map(b => (
                      <button key={b.marker}
                        disabled={busy !== null}
                        onClick={() => act(d, b.marker, BULK_LABEL[b.marker])}
                        className="text-[11.5px] font-bold px-2 py-1 rounded-lg border
                                   border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300
                                   hover:border-slate-300 dark:hover:border-white/25 transition-colors
                                   disabled:opacity-50">
                        {busy === `${d.repo} ${b.marker}` ? "…" : BULK_LABEL[b.marker]}
                      </button>
                    ))}
                  </div>
                </div>

                {items.length > 0 && (
                  <div className="mt-2.5 grid gap-1.5">
                    {items.map(item => {
                      const c = CATEGORY[item.category];
                      const marker = `${item.action}-branch=${item.branch}`;
                      return (
                        <div key={marker}
                          className="flex items-center gap-3 rounded-xl pl-0 pr-3 py-2 overflow-hidden
                                     bg-white dark:bg-white/[0.03] border border-slate-200/80 dark:border-white/[0.07]">
                          <span className={`w-1 self-stretch shrink-0 rounded-l-xl ${INTENT[c.intent].mark}`}
                            aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="text-[12.5px] font-semibold text-slate-800 dark:text-slate-100">
                              {item.title}
                            </span>
                            <span className="block font-mono text-[11px] text-slate-400 dark:text-slate-500 truncate">
                              {item.branch}
                            </span>
                          </span>
                          <span className="shrink-0 text-[11.5px] text-slate-500 dark:text-slate-400">
                            {c.label}
                          </span>
                          {/* A ticked box is a request Renovate has not run
                              yet. Offering it again would offer to do nothing. */}
                          {item.checked ? (
                            <span className="shrink-0 text-[11.5px] font-bold text-slate-400 dark:text-slate-500">
                              requested
                            </span>
                          ) : (
                            <button
                              disabled={busy !== null}
                              onClick={() => act(d, marker, c.verb)}
                              title={c.hint}
                              className="shrink-0 text-[11.5px] font-bold px-2.5 py-1 rounded-lg border
                                         border-slate-200 dark:border-white/10 text-slate-700 dark:text-slate-200
                                         hover:border-slate-300 dark:hover:border-white/25 transition-colors
                                         disabled:opacity-50">
                              {busy === `${d.repo} ${marker}` ? "…" : c.verb}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {isOpen && (
                  <div className="mt-2.5 pt-3 border-t border-slate-200/70 dark:border-white/[0.07]">
                    <DetectedDependencies repo={d.repo} issueNumber={d.issueNumber} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed max-w-[85ch]">
        These buttons tick the checkbox on the dashboard issue, which is how a self-hosted
        Renovate is instructed. It acts at its next run rather than immediately, so a request
        made now appears as a pull request whenever the bot is scheduled next.
      </p>
    </div>
  );
}
