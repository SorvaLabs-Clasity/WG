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
 * Everything Renovate is doing, as an operations queue.
 *
 * Two rewrites got here. The first split pull requests from the dashboard,
 * which is one subject cut down the middle. The second joined them but drew
 * five equal tiles and a tree of identical grey rows, so fourteen broken things
 * carried exactly the same visual mass as two thousand fine ones and nothing
 * told the eye where to go.
 *
 * The rules this one holds to, each one a thing the last version did wrong:
 *
 *   - **Two radii.** Zero on every surface, 2px on every pressable. The panel
 *     is border-y only and full-bleed, so it reads as part of the page rather
 *     than a floating card.
 *   - **Three greys per theme**, one per role: data, secondary, tertiary. No
 *     catch-all grey doing four jobs.
 *   - **Colour in exactly two places**: the queue bar, and a 3px status gutter
 *     at the left edge of each row. Nowhere else. Colour that appears in a
 *     dozen tinted borders stops meaning anything.
 *   - **Three type sizes** with gaps you can see: 10px tracked caps for heads,
 *     12.5px for data, 22px for the one total that matters.
 *   - **The face is the hierarchy.** Every machine-authored string is mono:
 *     repository, package, version, branch, number. Prose is not.
 *   - **Fixed row heights**, 26px, on a 4px unit. Not padding you nudge.
 *   - **Hover moves the gutter, not the background.** A background hover in
 *     dark mode is mathematically invisible.
 *
 * And the summary is one proportional bar rather than five boxes, so the
 * geometry *is* the distribution: if two thousand updates are held back and
 * fourteen are broken, the bar shows that, and the fourteen still get a
 * minimum width because zero-width is unclickable.
 */

type Lens = "errored" | "failing" | "waiting" | "ready" | "held";

/** Worst first. The order is the order somebody works through them. */
const LENSES: { id: Lens; label: string; hue: string; text: string }[] = [
  { id: "errored", label: "Errored", hue: "#e0483d", text: "text-[#c0392b] dark:text-[#ff7a6e]" },
  { id: "failing", label: "Failing", hue: "#e07b39", text: "text-[#b35c1e] dark:text-[#ffa05c]" },
  { id: "waiting", label: "Waiting on you", hue: "#7b5cd6", text: "text-[#5b3fb0] dark:text-[#b49cff]" },
  { id: "ready", label: "Ready", hue: "#2f9e5f", text: "text-[#1f7a46] dark:text-[#5fd08d]" },
  { id: "held", label: "Held back", hue: "#8b93a3", text: "text-[#6c7488] dark:text-[#8b93a3]" },
];

const HUE = Object.fromEntries(LENSES.map(l => [l.id, l.hue])) as Record<Lens, string>;

/** Which lens a dashboard state belongs to, where it is not already a pull request. */
const LENS_OF: Record<DashboardCategory, Lens | null> = {
  errored: "errored", blocked: "errored",
  "pending-approval": "waiting", "pr-approval-required": "waiting",
  "rate-limited": "held", "awaiting-schedule": "held",
  "group-size-not-met": "held", "pending-checks": "held", other: "held",
  // Covered by the pull request it refers to, which knows whether it is ready.
  open: null,
};

const VERB: Record<DashboardCategory, string> = {
  errored: "Retry", blocked: "Recreate", "rate-limited": "Create",
  "pending-approval": "Approve", "pr-approval-required": "Approve",
  "group-size-not-met": "Create", "awaiting-schedule": "Run",
  "pending-checks": "Unpend", other: "Request", open: "Rebase",
};

const BULK_LABEL: Record<string, string> = {
  "create-all-rate-limited-prs": "create all rate-limited",
  "approve-all-pending-prs": "approve all pending",
  "create-all-awaiting-schedule-prs": "run all scheduled",
  "rebase-all-open-prs": "rebase all open",
  "create-config-migration-pr": "open config migration",
  "manual job": "run renovate now",
};

/** The three greys, one per role, and nothing else. */
const DATA = "text-[#1f2430] dark:text-[#e6e9ef]";
const SECOND = "text-[#6c7488] dark:text-[#8b93a3]";
const THIRD = "text-[#9aa1af] dark:text-[#5a6270]";
const HEAD = `text-[10px] uppercase tracking-[0.16em] font-semibold ${THIRD}`;
const RULE = "border-[#e4e7ec] dark:border-[#252b36]";

interface Row {
  repo: string;
  branch: string;
  title: string;
  /** The package, split out of Renovate's title for its own column. */
  name: string;
  lens: Lens;
  from?: string;
  to?: string;
  pr?: RenovatePr;
  marker?: string;
  verb?: string;
  requested?: boolean;
  issueNumber?: number;
}

/**
 * The version transition, pulled out of Renovate's own title.
 *
 * Its titles are "Update dependency lodash to v4.17.21" and "Update x from a to
 * b", so the package and the target are in there and worth their own columns.
 * Anything that does not match keeps its full title in the name column rather
 * than being mangled into one.
 */
function split(title: string): { name: string; from?: string; to?: string } {
  const from = /^Update (?:dependency )?(\S+) from (\S+) to (\S+)$/.exec(title);
  if (from) return { name: from[1], from: from[2], to: from[3] };
  const to = /^Update (?:dependency )?(\S+) to (\S+)$/.exec(title);
  if (to) return { name: to[1], to: to[2] };
  return { name: title };
}

function Inventory({ repo, issueNumber, query }: { repo: string; issueNumber: number; query: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["renovate", "detected", repo, issueNumber],
    queryFn: () => fetchDetectedDependencies(repo, issueNumber),
    staleTime: 300_000,
  });

  if (isLoading) return <div className={`h-[26px] leading-[26px] pl-8 text-[12.5px] ${THIRD}`}>reading…</div>;

  const manifests = (data?.detected ?? [])
    .map(m => ({ ...m, packages: query ? m.packages.filter(p => p.toLowerCase().includes(query)) : m.packages }))
    .filter(m => m.packages.length > 0);

  if (manifests.length === 0) {
    return <div className={`h-[26px] leading-[26px] pl-8 text-[12.5px] ${THIRD}`}>nothing listed</div>;
  }

  return (
    <div className="pb-1">
      {manifests.map(m => (
        <div key={`${m.ecosystem} ${m.manifest}`}>
          <div className={`h-[22px] leading-[22px] pl-8 font-mono text-[10px] uppercase tracking-[0.16em] ${THIRD}`}>
            {m.manifest}
          </div>
          {m.packages.map(pkg => (
            <div key={pkg} className={`h-[22px] leading-[22px] pl-12 font-mono text-[12.5px] ${SECOND}`}>
              {pkg}
            </div>
          ))}
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
    queryKey: ["renovate", "details"], queryFn: () => fetchRenovate(true), staleTime: 120_000,
  });
  const dash = useQuery({
    queryKey: ["renovate", "dashboards"], queryFn: fetchRenovateDashboards, staleTime: 120_000,
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

  const botField = (
    <div className="flex gap-2 max-w-md">
      <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
        placeholder="e.g. my-renovate"
        className={`flex-1 h-[30px] px-2.5 rounded-[2px] font-mono text-[12.5px] bg-transparent
                    border ${RULE} ${DATA} focus:outline-none focus:border-[#7b5cd6]`} />
      <button onClick={() => saveBot.mutate(botDraft)} disabled={!botDraft.trim()}
        className="h-[30px] px-3 rounded-[2px] text-[12.5px] font-semibold
                   bg-[#1f2430] dark:bg-[#e6e9ef] text-white dark:text-[#1f2430] disabled:opacity-40">
        Save
      </button>
    </div>
  );

  if (prs.data && !prs.data.configured) {
    return (
      <div className={`border-y ${RULE} py-5`}>
        <div className={HEAD}>Renovate</div>
        <p className={`text-[12.5px] ${SECOND} mt-2 max-w-2xl leading-relaxed`}>
          A self-hosted Renovate raises its pull requests and keeps its dashboard as a GitHub App,
          and its authorship is the only way to find them. Type the name shown beside one of its
          pull requests; the <span className="font-mono">[bot]</span> suffix an App's login carries
          is added for you.
        </p>
        <div className="mt-3">
          {isAdmin ? botField
            : <p className={`text-[12.5px] ${SECOND}`}>An organization admin has to set the bot account.</p>}
        </div>
      </div>
    );
  }

  if (dash.data?.unknownBot || prs.data?.unknownBot) {
    return (
      <div className={`border-y ${RULE} py-5`}>
        <div className={HEAD}>Bot not found</div>
        <p className={`text-[12.5px] ${SECOND} mt-2 max-w-2xl leading-relaxed`}>
          GitHub does not recognise <span className={`font-mono ${DATA}`}>{bot}</span>. A
          self-hosted Renovate raises its work as a GitHub App, whose login carries a{" "}
          <span className="font-mono">[bot]</span> suffix that GitHub's own pages hide, so the name
          shown beside a pull request is not the name search wants.
        </p>
        {isAdmin && <div className="mt-3">{botField}</div>}
      </div>
    );
  }

  const dashboards: RepoDashboard[] = dash.data?.dashboards ?? [];
  const openPrs = (prs.data?.prs ?? []).filter(p => p.state === "open");

  // Joined on the branch, which is the key Renovate writes into both.
  const byBranch = new Map<string, RenovatePr>();
  for (const pr of openPrs) if (pr.headRefName) byBranch.set(`${pr.repo}|${pr.headRefName}`, pr);

  const lensOfPr = (pr: RenovatePr): Lens =>
    pr.readiness === "ready" ? "ready"
      : pr.readiness === "failing" || pr.readiness === "conflicting" ? "failing" : "held";

  const rows: Row[] = [];
  const claimed = new Set<string>();

  for (const d of dashboards) {
    for (const item of d.items) {
      const key = `${d.repo}|${item.branch}`;
      const pr = byBranch.get(key);
      const l = pr ? lensOfPr(pr) : LENS_OF[item.category];
      if (!l) continue;
      if (pr) claimed.add(key);
      rows.push({
        repo: d.repo, branch: item.branch, lens: l, ...split(item.title), title: item.title,
        pr, marker: `${item.action}-branch=${item.branch}`, verb: VERB[item.category],
        requested: item.checked, issueNumber: d.issueNumber,
      });
    }
  }
  // Pull requests on repositories with no dashboard. Dropping them would make a
  // repository without one look like a repository with no Renovate activity.
  for (const pr of openPrs) {
    const key = `${pr.repo}|${pr.headRefName ?? ""}`;
    if (claimed.has(key)) continue;
    rows.push({
      repo: pr.repo, branch: pr.headRefName ?? "", lens: lensOfPr(pr),
      ...split(pr.title), title: pr.title, pr,
    });
  }

  const counts = Object.fromEntries(
    LENSES.map(l => [l.id, rows.filter(r => r.lens === l.id).length])) as Record<Lens, number>;
  const total = rows.length;

  const query = raw.trim().toLowerCase();
  const visible = rows.filter(r =>
    (!lens || r.lens === lens)
    && (!query || `${r.repo} ${r.name} ${r.branch} ${r.title}`.toLowerCase().includes(query)));

  const groups = [...new Set(visible.map(r => r.repo))].sort().map(repo => ({
    repo,
    rows: visible.filter(r => r.repo === repo)
      .sort((a, b) => LENSES.findIndex(l => l.id === a.lens) - LENSES.findIndex(l => l.id === b.lens)),
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
    const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); apply(next);
  };

  const stamp = dash.data?.computedAt ?? prs.data?.computedAt;
  const present = LENSES.filter(l => counts[l.id] > 0);

  return (
    <div>
      {/* ── the queue, as one bar ──────────────────────────────────────────
          Widths are the counts, so the geometry is the distribution. Five
          equal tiles gave fourteen broken updates the same mass as two
          thousand held back, which is the opposite of what the eye needs. */}
      <div className="flex items-end justify-between gap-4 mb-2">
        <div>
          <div className={HEAD}>Renovate queue</div>
          <div className={`text-[22px] font-semibold tabular-nums leading-none mt-1 ${DATA}`}>
            {total.toLocaleString()}
            <span className={`ml-2 text-[12.5px] font-normal ${SECOND}`}>
              across {dashboards.length || new Set(rows.map(r => r.repo)).size} repositories
            </span>
          </div>
        </div>
        <div className={`text-[10px] uppercase tracking-[0.16em] ${THIRD} text-right leading-relaxed`}>
          <div className="font-mono normal-case tracking-normal text-[12.5px]">{bot}</div>
          {stamp && (
            <div className="tabular-nums">
              read {new Date(stamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {(dash.data?.refreshing || prs.data?.refreshing) && " · refreshing"}
            </div>
          )}
        </div>
      </div>

      {total > 0 && (
        <div className="flex h-[28px] w-full overflow-hidden rounded-[2px]">
          {present.map(l => (
            <button key={l.id} onClick={() => setLens(lens === l.id ? null : l.id)}
              title={`${counts[l.id]} ${l.label.toLowerCase()}`}
              style={{ flexGrow: counts[l.id], backgroundColor: l.hue,
                       opacity: lens && lens !== l.id ? 0.25 : 1 }}
              className="min-w-[44px] flex items-center justify-center gap-1.5 transition-opacity
                         text-white text-[11px] font-semibold tabular-nums">
              {counts[l.id]}
              <span className="hidden lg:inline font-normal opacity-90 text-[10px] uppercase tracking-[0.12em]">
                {l.label}
              </span>
            </button>
          ))}
        </div>
      )}

      <div className={`flex items-center gap-3 mt-2 text-[10px] uppercase tracking-[0.16em] ${THIRD}`}>
        {lens
          ? <button onClick={() => setLens(null)} className="hover:opacity-70">
              showing {LENSES.find(l => l.id === lens)!.label} · clear
            </button>
          : <span>click a segment to filter</span>}
        {isAdmin && (
          <button onClick={() => { setBotDraft(bot ?? ""); setEditing(!editing); }}
            className="ml-auto hover:opacity-70">change bot</button>
        )}
      </div>

      {editing && isAdmin && <div className="mt-2">{botField}</div>}

      {notice && (
        <div className={`mt-2 h-[26px] leading-[26px] px-2 rounded-[2px] text-[12.5px]
                         ${notice.ok ? "text-[#1f7a46] dark:text-[#5fd08d]" : "text-[#b35c1e] dark:text-[#ffa05c]"}`}>
          {notice.msg}
        </div>
      )}

      <input value={raw} onChange={e => setRaw(e.target.value)}
        placeholder="filter"
        className={`mt-3 w-full h-[30px] px-2.5 rounded-[2px] bg-transparent border ${RULE}
                    font-mono text-[12.5px] ${DATA} placeholder:${THIRD}
                    focus:outline-none focus:border-[#7b5cd6]`} />

      {/* ── column heads, the one rule in the whole panel ───────────────── */}
      <div className={`grid grid-cols-[3px_minmax(0,1fr)_132px_90px_64px] items-center
                       h-[22px] mt-3 border-b ${RULE} ${HEAD}`}>
        <span />
        <span className="pl-3">package</span>
        <span>version</span>
        <span>state</span>
        <span className="text-right pr-1">act</span>
      </div>

      {groups.length === 0 ? (
        <div className={`h-[26px] leading-[26px] pl-3 text-[12.5px] ${THIRD}`}>
          {lens || query ? "nothing matches" : "nothing outstanding"}
        </div>
      ) : groups.map(({ repo, rows: group, dashboard }) => {
        const open = query ? true : !shut.has(repo);
        return (
          <div key={repo} className={`border-b ${RULE}`}>
            <button onClick={() => toggle(shut, repo, setShut)} aria-expanded={open}
              className="w-full h-[22px] flex items-center gap-2 text-left group">
              <span className="flex h-full w-[3px] shrink-0">
                {LENSES.filter(l => group.some(r => r.lens === l.id)).map(l => (
                  <span key={l.id} className="flex-1" style={{ backgroundColor: l.hue }} />
                ))}
              </span>
              <span className={`font-mono text-[12.5px] ${DATA} truncate group-hover:opacity-70`}>
                {repo}
              </span>
              <span className={`text-[10px] tabular-nums ${THIRD}`}>{group.length}</span>
              <span className={`ml-auto pr-1 text-[10px] uppercase tracking-[0.16em] ${THIRD}`}>
                {open ? "hide" : "show"}
              </span>
            </button>

            {open && group.map(r => {
              const running = busy === `${r.repo}|${r.marker}`;
              return (
                <div key={`${r.repo}|${r.branch}|${r.title}`}
                  className="group grid grid-cols-[3px_minmax(0,1fr)_132px_90px_64px]
                             items-center h-[26px]">
                  {/* Colour lives here and in the bar, nowhere else. Hover
                      widens it rather than tinting the row, because a dark-mode
                      background hover is invisible. */}
                  <span className="h-full origin-left transition-transform duration-100
                                   group-hover:scale-x-[1.67]"
                    style={{ backgroundColor: HUE[r.lens] }} />

                  <span className={`pl-3 font-mono text-[12.5px] ${DATA} truncate`} title={r.title}>
                    {r.name}
                  </span>

                  <span className={`font-mono text-[12.5px] ${SECOND} truncate`}>
                    {r.from ? `${r.from} → ${r.to}` : r.to ?? ""}
                  </span>

                  <span className={`text-[12.5px] ${LENSES.find(l => l.id === r.lens)!.text} truncate`}>
                    {r.pr
                      ? (r.pr.checks === "SUCCESS" ? "checks passed"
                        : r.pr.checks === "FAILURE" || r.pr.checks === "ERROR" ? "checks failed"
                        : r.pr.mergeable === "CONFLICTING" ? "conflicts"
                        : r.pr.checks === "PENDING" ? "checks running"
                        : r.pr.reviewDecision === "REVIEW_REQUIRED" ? "review needed" : "open")
                      : LENSES.find(l => l.id === r.lens)!.label.toLowerCase()}
                  </span>

                  <span className="flex items-center justify-end gap-1 pr-1">
                    {r.pr && (
                      <a href={r.pr.url} target="_blank" rel="noopener noreferrer"
                        title={`#${r.pr.number}`}
                        className={`font-mono text-[11px] tabular-nums ${THIRD} hover:${DATA}`}>
                        #{r.pr.number}
                      </a>
                    )}
                    {r.marker && r.issueNumber !== undefined && (
                      r.requested
                        ? <span className={`text-[10px] uppercase tracking-[0.16em] ${THIRD}`}>sent</span>
                        : <button disabled={busy !== null}
                            onClick={() => act(r.repo, r.issueNumber!, r.marker!, r.verb!)}
                            className={`h-[18px] px-1.5 rounded-[2px] text-[11px] font-semibold
                                        ${SECOND} hover:bg-[#eceef2] dark:hover:bg-[#252b36]
                                        disabled:opacity-40 transition-colors`}>
                            {running ? "…" : r.verb}
                          </button>
                    )}
                  </span>
                </div>
              );
            })}

            {open && dashboard && (
              <div className="flex items-center gap-3 pl-3 h-[22px]">
                {dashboard.bulk.filter(b => !b.checked && BULK_LABEL[b.marker]).map(b => (
                  <button key={b.marker} disabled={busy !== null}
                    onClick={() => act(repo, dashboard.issueNumber, b.marker, BULK_LABEL[b.marker])}
                    className={`text-[10px] uppercase tracking-[0.16em] ${THIRD}
                                hover:text-[#1f2430] dark:hover:text-[#e6e9ef] disabled:opacity-40`}>
                    {BULK_LABEL[b.marker]}
                  </button>
                ))}
                {dashboard.detectedPackages > 0 && (
                  <button onClick={() => toggle(invOpen, repo, setInvOpen)}
                    aria-expanded={invOpen.has(repo)}
                    className={`ml-auto pr-1 text-[10px] uppercase tracking-[0.16em] ${THIRD}
                                hover:text-[#1f2430] dark:hover:text-[#e6e9ef]`}>
                    {invOpen.has(repo) ? "hide" : "show"} {dashboard.detectedPackages} dependencies
                  </button>
                )}
              </div>
            )}
            {open && dashboard && invOpen.has(repo) && (
              <Inventory repo={repo} issueNumber={dashboard.issueNumber} query={query} />
            )}
          </div>
        );
      })}

      <p className={`mt-3 text-[12.5px] ${THIRD} leading-relaxed max-w-[80ch]`}>
        Acting here ticks a checkbox on the repository's dashboard issue, which is how a
        self-hosted Renovate is instructed. It acts at its next run, not immediately. Nothing
        here merges anything.
        {dashboards.length === 0 && (
          <> No dependency dashboards were found, so only pull requests are listed: Renovate keeps
          one per repository where its config sets <span className="font-mono">dependencyDashboard</span>.</>
        )}
      </p>
    </div>
  );
}
