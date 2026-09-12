import { useState } from "react";
import { idleLabel } from "../lib/idle";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../App";
import { apiGet, apiPut, apiPost } from "../api/client";
import { usePermissions } from "../hooks/usePermissions";
import { useRepos } from "../hooks/useRepos";
import { Page, Empty, Spinner, Pager, SearchInput } from "../design";
import UserAvatar from "../components/UserAvatar";
import PrReminderSettings, { type Mutes } from "../components/PrReminderSettings";

type BlockReason =
  | "ready" | "needs-approval" | "changes-requested"
  | "draft" | "conflict" | "behind" | "checks-failing" | "checks-pending" | "blocked";

type MuteScope = "everywhere" | "repository" | "this pull request";

interface Pull {
  repo: string; number: number; title: string; url: string; author: string;
  headRef: string; baseRef: string;
  idleDays: number; stale: boolean;
  blockReason: BlockReason;
  requestedReviewers: string[];
  pendingReviewers: string[];
  wouldNudge: string[];
  muted: Array<{ login: string; scope: MuteScope }>;
  paused: boolean;
  pausedLogins: string[];
  lastNudgedAt: string | null;
  nudgeCount: number;
}

interface Answer {
  monitoringEnabled: boolean;
  remindersEnabled: boolean;
  staleSeconds: number;
  truncated: boolean;
  /** When the stored list was taken. Null when this response was walked live. */
  cachedAt?: string | null;
  open: number;
  stale: number;
  pulls: Pull[];
  mutes: Mutes;
}

/**
 * Each state's colour and label.
 *
 * Only two of these mean reviewers are worth chasing, and they are the two warm
 * colours; everything else is the author's to fix and reads cooler. The palette
 * is doing the same job as the targeting rule, so a glance down the list
 * separates "waiting on people" from "waiting on work".
 */
const BLOCK: Record<BlockReason, { label: string; chip: string; dot: string }> = {
  "ready":             { label: "Ready to merge",    chip: "bg-forest-wash text-forest border-forest-edge",   dot: "bg-forest" },
  "needs-approval":    { label: "Needs review",      chip: "bg-ochre-wash text-ochre border-ochre-edge",      dot: "bg-ochre" },
  "changes-requested": { label: "Changes requested", chip: "bg-ochre-wash text-ochre border-ochre-edge",      dot: "bg-ochre" },
  "conflict":          { label: "Conflicts",         chip: "bg-crimson-wash text-crimson border-crimson-edge", dot: "bg-crimson" },
  "checks-failing":    { label: "Checks failing",    chip: "bg-crimson-wash text-crimson border-crimson-edge", dot: "bg-crimson" },
  "behind":            { label: "Behind base",       chip: "bg-indigo-wash text-indigo border-indigo-edge",   dot: "bg-indigo" },
  "checks-pending":    { label: "Checks running",    chip: "bg-paper-2 text-ink-2 border-rule",               dot: "bg-rule-strong" },
  "draft":             { label: "Draft",             chip: "bg-paper-2 text-ink-2 border-rule",               dot: "bg-rule-strong" },
  "blocked":           { label: "Blocked",           chip: "bg-paper-2 text-ink-2 border-rule",               dot: "bg-rule-strong" },
};

function thresholdLabel(secs: number): string {
  if (secs >= 86_400) return `${Math.round(secs / 86_400)} days`;
  if (secs >= 3_600) return `${Math.round(secs / 3_600)} hours`;
  if (secs >= 60) return `${Math.round(secs / 60)} minutes`;
  return `${secs} seconds`;
}

function Switch({ on, onChange, disabled }: {
  on: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button onClick={() => onChange(!on)} disabled={disabled} role="switch" aria-checked={on}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center border border-rule-strong transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "bg-ink" : "bg-paper-2"}`}>
      <span className={`inline-block h-3 w-3 transform transition-transform ${
        on ? "translate-x-[1.15rem] bg-paper" : "translate-x-[0.2rem] bg-ink-3"}`} />
    </button>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <div className="text-right">
      <p className={`figure text-[2rem] ${tone ?? "text-ink"}`}>{n}</p>
      <p className="caps mt-1.5">{label}</p>
    </div>
  );
}

/** "4 minutes ago", down to a minute, below that, "just now". */
function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "unknown";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} day${Math.floor(hours / 24) === 1 ? "" : "s"} ago`;
}

export default function PullRequestsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();

  // Every repository in the organization, not only the ones with a pull request
  // open right now. Muting somebody on a quiet repository is the case worth
  // supporting. It is set once, before the first pull request lands there.
  const { data: allRepos, isLoading: reposLoading } = useRepos();

  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [stalePage, setStalePage] = useState(1);
  const [freshPage, setFreshPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Polled rather than cached for minutes: a pull request opened a moment ago
  // should appear without restarting the app. Polling stops entirely when the
  // feature is off, so "off" does not keep asking for a list nothing will build.
  const { data, isLoading, isFetching, error: loadError, refetch } = useQuery<Answer>({
    queryKey: ["pulls"],
    queryFn: () => apiGet<Answer>("/pulls"),
    staleTime: 15_000,
    refetchInterval: (q) => (q.state.data?.monitoringEnabled === false ? false : 30_000),
    refetchOnWindowFocus: true,
  });

  const after = (msg?: string) => ({
    onSuccess: () => {
      setError(""); if (msg) setNotice(msg);
      qc.invalidateQueries({ queryKey: ["pulls"] });
    },
    onError: (e: any) => { setNotice(""); setError(e?.message || "That did not work."); },
  });

  /**
   * The two switches, applied to the cache the moment the save returns.
   *
   * These read their position from the `pulls` query, and the ordinary success
   * path invalidates it, which refetches the whole pull request list, several
   * seconds of GitHub work. So the switch sat visibly still until a list nobody
   * was waiting for came back, and pressing it again in the meantime sent a
   * second save. The server already returns the saved settings; writing them
   * into the cache moves the switch at once, and the list still refreshes behind
   * it because it can also change what is listed.
   */
  /**
   * The refresh button: a live read, written straight into the cache.
   *
   * A mutation rather than `refetch()`, because the ordinary query is allowed to
   * serve the stored snapshot and this one must not. The result replaces the
   * cache directly, so the list updates without a second round trip.
   */
  const refreshNow = useMutation({
    mutationFn: () => apiGet<Answer>("/pulls?refresh=1"),
    onSuccess: (fresh) => { setError(""); qc.setQueryData<Answer>(["pulls"], fresh); },
    onError: (e: any) => setError(e?.message || "Could not refresh from GitHub."),
  });

  const saveSettings = useMutation({
    mutationFn: (b: { monitoringEnabled?: boolean; remindersEnabled?: boolean }) =>
      apiPut<{ monitoringEnabled?: boolean; remindersEnabled?: boolean }>("/pulls/settings", b),
    onSuccess: (saved) => {
      setError("");
      qc.setQueryData<Answer>(["pulls"], (prev) => prev && ({
        ...prev,
        ...(saved?.monitoringEnabled !== undefined && { monitoringEnabled: saved.monitoringEnabled }),
        ...(saved?.remindersEnabled !== undefined && { remindersEnabled: saved.remindersEnabled }),
      }));
      qc.invalidateQueries({ queryKey: ["pulls"] });
    },
    onError: (e: any) => { setNotice(""); setError(e?.message || "That did not work."); },
  });
  const pause = useMutation({
    mutationFn: (b: { repo: string; number: number; paused?: boolean; pausedLogins?: string[] }) =>
      apiPut<unknown>("/pulls/pause", b), ...after(),
  });
  const mute = useMutation({
    mutationFn: (b: { scope: "global" | "repo"; target: string; muted: boolean; repo?: string }) =>
      apiPut<unknown>("/pulls/mute", b), ...after(),
  });
  const runNow = useMutation({
    mutationFn: () => apiPost<{ due: number; posted: number; skippedPaused: number; failed: number }>("/pulls/run", {}),
    onSuccess: (r) => {
      setError("");
      setNotice(r.posted ? `Sent ${r.posted} reminder${r.posted === 1 ? "" : "s"}.`
        : r.due === 0 ? "Nothing was due."
        : `${r.due} due, none sent. Everyone who would be named is muted.`);
      qc.invalidateQueries({ queryKey: ["pulls"] });
    },
    onError: (e: any) => setError(e?.message || "Could not send reminders."),
  });

  if (isLoading) return <Page user={user}><Spinner label="Reading the pull requests" /></Page>;
  if (loadError) {
    return <Page user={user}>
      <Empty title="Could not read pull requests" body={(loadError as Error).message} />
    </Page>;
  }

  const monitoring = data?.monitoringEnabled !== false;
  const reminders = !!data?.remindersEnabled;
  const mutes: Mutes = data?.mutes ?? { global: [], byRepo: {} };
  const busy = pause.isPending || mute.isPending || saveSettings.isPending;

  const q = search.trim().toLowerCase();
  const all = (data?.pulls ?? []).filter(p => !q
    || `${p.repo}#${p.number} ${p.title} ${p.author} ${p.headRef} ${p.baseRef}`.toLowerCase().includes(q));
  const stale = all.filter(p => p.stale);
  const fresh = all.filter(p => !p.stale);
  const repos = (allRepos ?? []).map(r => r.full_name);

  const PER_PAGE = 20;
  // Clamped rather than trusted: filtering can shrink a list under the page
  // being viewed, which would show an empty section while page one was full.
  const page = (rows: Pull[], n: number) => {
    const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const safe = Math.min(Math.max(1, n), totalPages);
    return { totalPages, safe, slice: rows.slice((safe - 1) * PER_PAGE, safe * PER_PAGE) };
  };
  const sv = page(stale, stalePage);
  const fv = page(fresh, freshPage);

  /**
   * Built by plain calls rather than declared as components here.
   *
   * A component declared inside a render is a new type on every render, so React
   * discards the rows and rebuilds them each time, on every poll, and on every
   * keystroke in the search box, instead of updating them in place.
   */
  const card = (p: Pull) => {
    const b = BLOCK[p.blockReason] ?? BLOCK.blocked;
    const key = `${p.repo}#${p.number}`;
    const open = expanded === key;
    const silent = p.stale && reminders && !p.paused && p.wouldNudge.length === 0;

    return (
      <li className="relative border border-rule bg-paper hover:bg-ink/[0.035] transition-colors">
        <span className={`absolute left-0 top-0 bottom-0 w-[3px] ${b.dot}`} aria-hidden="true" />
        <div className="pl-6 pr-4 py-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <a href={p.url} target="_blank" rel="noopener noreferrer"
                className="display text-[1.125rem] leading-snug text-ink block no-underline hover:underline underline-offset-4 decoration-rule-strong">
                {p.title}
              </a>
              <div className="dateline mt-2">
                <span className="inline-flex items-center gap-1.5">
                  <UserAvatar login={p.author} size={15} />{p.author}
                </span>
                <span className="font-mono">{p.repo}<span className="text-ink-3">#{p.number}</span></span>
                {/* Direction spelled out: two bare branch names get read the
                    wrong way round about half the time. */}
                <span className="font-mono text-ink-3">
                  {p.headRef} <span aria-hidden="true">→</span> {p.baseRef}
                </span>
              </div>
            </div>
            <div className="flex items-baseline gap-4 shrink-0">
              <span className={`caps caps-tight px-1.5 py-1 border ${b.chip}`}>{b.label}</span>
              <span className="figure text-[1.125rem] text-ink w-10 text-right"
                title="Since the last commit. The clock reminders run on">
                {idleLabel(p.idleDays)}
              </span>
            </div>
          </div>

          {/* On every open pull request, not only the stale ones.
              Muting somebody is something you decide when you notice it -
              usually while the pull request is still fresh, and a panel that
              only appears after seven days of silence means the mute can only
              be set once the first reminder has already gone out. Anything not
              yet stale reads as what *will* happen rather than what has. */}
          {(p.stale || (isAdmin && reminders)) && (
            <div className="mt-4 pt-3 border-t border-rule flex items-center justify-between gap-4 flex-wrap">
              <div className="text-[0.75rem] text-ink-2 min-w-0">
                {!reminders ? (
                  <span className="text-slate-400 dark:text-slate-500">Reminders are off</span>
                ) : p.paused ? (
                  <span className="inline-flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <i className="ph ph-pause-circle"></i>Paused
                  </span>
                ) : silent ? (
                  // The state that would otherwise read as the feature failing.
                  // The list is what makes it readable, so when there is no list
                  // the sentence has to stand without one.
                  <span className="text-slate-500 dark:text-slate-400">
                    {p.muted.length > 0
                      ? `Nobody to remind, ${p.muted.map(m => m.login).join(", ")} muted`
                      : "Nobody to remind"}
                  </span>
                ) : p.wouldNudge.length === 0 ? (
                  <span className="text-slate-400 dark:text-slate-500">
                    {p.muted.length > 0
                      ? `Would remind nobody, ${p.muted.map(m => m.login).join(", ")} muted`
                      : "Would remind nobody"}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 flex-wrap">
                    {/* Tense matters. "Reminds" on something with four days left
                        reads as a reminder that already went out. */}
                    <span className="text-slate-500 dark:text-slate-400">
                      {p.stale ? "Reminds" : "Would remind"}
                    </span>
                    {p.wouldNudge.map(l => (
                      <span key={l} className="inline-flex items-center gap-1.5 px-1.5 py-0.5 bg-paper-2 border border-rule">
                        <UserAvatar login={l} size={14} />
                        <span className="font-medium text-slate-700 dark:text-slate-200">{l}</span>
                      </span>
                    ))}
                    {!p.stale && (
                      <span className="text-slate-400 dark:text-slate-500">
                        in {idleLabel(Math.max(0, (data?.staleSeconds ?? 604_800) / 86_400 - p.idleDays))}
                      </span>
                    )}
                    {p.nudgeCount > 0 && (
                      <span className="text-slate-400 dark:text-slate-500">· {p.nudgeCount} sent</span>
                    )}
                  </span>
                )}
              </div>

              {isAdmin && reminders && (
                <button onClick={() => setExpanded(open ? null : key)}
                  className="textlink caps shrink-0">
                  {open ? "Done" : "Manage"}
                </button>
              )}
            </div>
          )}

          {open && isAdmin && reminders && (
            <div className="mt-3 pt-3 border-t border-slate-100 dark:border-rule space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200">Pause this pull request</p>
                  <p className="text-[0.6875rem] text-slate-500 dark:text-slate-400">
                    Nobody is reminded about it, the author included.
                  </p>
                </div>
                <Switch on={p.paused} disabled={busy}
                  onChange={v => pause.mutate({ repo: p.repo, number: p.number, paused: v })} />
              </div>

              {!p.paused && (
                <div>
                  <p className="text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5">Mute someone</p>
                  <div className="space-y-1.5">
                    {p.wouldNudge.map(l => (
                      <div key={l} className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="inline-flex items-center gap-1.5 text-xs text-slate-700 dark:text-slate-200">
                          <UserAvatar login={l} size={16} />{l}
                          {l === p.author && <span className="text-[0.625rem] text-slate-400">author</span>}
                        </span>
                        {/* Three scopes, because the question is asked at three
                            sizes and offering only the narrowest sends people
                            back here every week. */}
                        <span className="flex items-center gap-1.5">
                          <button disabled={busy}
                            onClick={() => pause.mutate({ repo: p.repo, number: p.number, pausedLogins: [...p.pausedLogins, l] })}
                            className="text-[0.6875rem] font-medium px-2 py-0.5 rounded-md ring-1 ring-inset ring-slate-300 dark:ring-rule text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-paper-3 disabled:opacity-40">
                            this PR
                          </button>
                          <button disabled={busy}
                            onClick={() => mute.mutate({ scope: "repo", repo: p.repo, target: l, muted: true })}
                            className="text-[0.6875rem] font-medium px-2 py-0.5 rounded-md ring-1 ring-inset ring-slate-300 dark:ring-rule text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-paper-3 disabled:opacity-40">
                            this repo
                          </button>
                          <button disabled={busy}
                            onClick={() => mute.mutate({ scope: "global", target: l, muted: true })}
                            className="text-[0.6875rem] font-medium px-2 py-0.5 rounded-md ring-1 ring-inset ring-slate-300 dark:ring-rule text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-paper-3 disabled:opacity-40">
                            everywhere
                          </button>
                        </span>
                      </div>
                    ))}

                    {p.muted.length > 0 && (
                      <div className="pt-2 mt-2 border-t border-slate-100 dark:border-rule space-y-1">
                        {p.muted.map(m => (
                          <div key={m.login} className="flex items-center justify-between gap-2 text-xs">
                            <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                              <UserAvatar login={m.login} size={16} />{m.login}
                              <span className="text-[0.625rem]">muted {m.scope}</span>
                            </span>
                            <button disabled={busy}
                              onClick={() => {
                                if (m.scope === "everywhere") mute.mutate({ scope: "global", target: m.login, muted: false });
                                else if (m.scope === "repository") mute.mutate({ scope: "repo", repo: p.repo, target: m.login, muted: false });
                                else pause.mutate({ repo: p.repo, number: p.number, pausedLogins: p.pausedLogins.filter(x => x.toLowerCase() !== m.login.toLowerCase()) });
                              }}
                              className="textlink caps">
                              unmute
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </li>
    );
  };

  const section = ({ title, hint, rows, view, onPage, total }: {
    title: string; hint?: string; rows: Pull[];
    view: { totalPages: number; safe: number; slice: Pull[] };
    onPage: (n: number) => void; total: number;
  }) => (
    <section>
      <div className="flex items-baseline gap-3 pb-2">
        <h2 className="caps text-ink">{title}</h2>
        <span className="figure text-[0.9375rem] text-ink-3">{rows.length}</span>
      </div>
      <div className="border-t-2 border-ink" />
      {hint && <p className="standfirst text-[0.8125rem] mt-3 mb-4 max-w-[76ch]">{hint}</p>}
      {rows.length === 0 ? (
        <p className="standfirst text-[0.8438rem] py-6">Nothing here.</p>
      ) : (
        <>
          <ul className="grid gap-3 mt-4">
            {view.slice.map(p => card(p))}
          </ul>
          {view.totalPages > 1 && (
            <div className="mt-3">
              <Pager page={view.safe} totalPages={view.totalPages} onPage={onPage}
                matchCount={rows.length} totalCount={total} filtered={!!q} noun="pull requests" />
            </div>
          )}
        </>
      )}
    </section>
  );

  return (
    <Page user={user}>
      <header className="mb-7 pb-3 border-b-2 border-ink">
        <div className="flex items-end justify-between gap-8 flex-wrap">
          <div>
            <h1 className="display text-[clamp(1.75rem,3vw,2.25rem)] text-ink">Open pull requests</h1>
            <p className="standfirst text-[0.875rem] mt-2 max-w-[62ch]">
              Every open pull request in the organization, most idle first, closed ones never
              appear. Idle counts from the last <strong className="font-semibold">commit</strong>,
              not from when it was opened.
            </p>
          </div>
          {monitoring && (
            <div className="flex items-start gap-8 columned">
              <Stat n={data?.open ?? 0} label="open" />
              <div className="pl-8">
                <Stat n={data?.stale ?? 0} label="stale"
                  tone={(data?.stale ?? 0) > 0 ? "text-ochre" : undefined} />
              </div>
            </div>
          )}
        </div>
      </header>

      {isAdmin && (
        <div className="mb-7 border border-rule bg-paper divide-y divide-rule">
          <div className="px-5 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="display text-[1.0625rem] text-ink">Monitor pull requests</p>
              <p className="standfirst text-[0.7812rem] mt-1">
                Off means nothing is fetched, listed or posted, and nothing runs on the schedule.
              </p>
            </div>
            <Switch on={monitoring} disabled={busy}
              onChange={v => saveSettings.mutate({ monitoringEnabled: v })} />
          </div>

          <div className={`px-5 py-3 flex items-center justify-between gap-4 ${monitoring ? "" : "opacity-50"}`}>
            <div>
              <p className="display text-[1.0625rem] text-ink">Post reminders</p>
              <p className="standfirst text-[0.7812rem] mt-1">
                One comment on anything idle for {thresholdLabel(data?.staleSeconds ?? 604_800)}, replacing
                itself each time rather than adding another.
              </p>
            </div>
            <Switch on={reminders} disabled={busy || !monitoring}
              onChange={v => saveSettings.mutate({ remindersEnabled: v })} />
          </div>

          {monitoring && reminders && (
            <div className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
              <button onClick={() => setShowSettings(true)}
                className="stamp stamp-hollow stamp-sm">
                Reminder mutes
                {(mutes.global.length + Object.values(mutes.byRepo).flat().length) > 0 && (
                  <span className="figure text-[0.875rem]">
                    {mutes.global.length + Object.values(mutes.byRepo).flat().length}
                  </span>
                )}
              </button>
              <button onClick={() => runNow.mutate()} disabled={runNow.isPending}
                title="Run the reminder pass now instead of waiting for the next scheduled one"
                className="stamp stamp-sm">
                {runNow.isPending ? "Sending…" : "Send reminders now"}
              </button>
            </div>
          )}
        </div>
      )}

      <PrReminderSettings
        open={showSettings && isAdmin && monitoring && reminders}
        onClose={() => setShowSettings(false)}
        mutes={mutes} repos={repos} reposLoading={reposLoading} busy={busy}
        onMute={(scope, target, muted, repo) => mute.mutate({ scope, target, muted, repo })} />

      {/* Shown only when the threshold is not the real one, since an override
          left on would otherwise remind everyone every few minutes with nothing
          on screen explaining why. */}
      {(data?.staleSeconds ?? 604_800) < 86_400 && (
        <div className="mb-5 bg-ochre-wash border-l-2 border-ochre pl-4 pr-3 py-2.5 text-[0.8438rem] text-ochre">
          <strong>Test threshold active.</strong> Pull requests count as stale after{" "}
          {thresholdLabel(data?.staleSeconds ?? 0)} instead of 7 days.{" "}
          <code className="px-1 rounded bg-black/10 dark:bg-ink/10">STALE_SECONDS</code> in{" "}
          <code className="px-1 rounded bg-black/10 dark:bg-ink/10">prNudgeService.ts</code> controls it.
        </div>
      )}

      {notice && (
        <div className="mb-5 bg-forest-wash border-l-2 border-forest pl-4 pr-3 py-2.5 text-[0.8438rem] text-forest">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-5 bg-crimson-wash border-l-2 border-crimson pl-4 pr-3 py-2.5 text-[0.8438rem] text-crimson">
          {error}
        </div>
      )}

      {!monitoring ? (
        <Empty title="Monitoring is off"
          body={isAdmin
            ? "Nothing is fetched, listed or posted, and nothing runs on the schedule for it. Use the switch above."
            : "An organization admin has switched this off."} />
      ) : (
        <>
          <div className="mb-6 flex items-end gap-6">
            <div className="flex-1 min-w-0">
              <SearchInput value={search}
                onChange={(v: string) => { setSearch(v); setStalePage(1); setFreshPage(1); }}
                placeholder="Search title, repository, author or branch…" />
            </div>
            {/* Goes and asks GitHub, rather than re-reading what is stored.
                Without `refresh=1` this would return the same snapshot: the
                button would spin, finish, and change nothing, which teaches
                people that refreshing does not work. */}
            <button onClick={() => refreshNow.mutate()} disabled={isFetching || refreshNow.isPending}
              title="Reads GitHub now. The list refreshes on its own every few minutes."
              className="textlink caps shrink-0">
              {isFetching || refreshNow.isPending ? "Reading GitHub…" : "Read GitHub now"}
            </button>
          </div>

          {/* How old the list is, when it did not come from a live walk.
              Shown rather than implied: reading GitHub takes seconds on a large
              organization, so the tab opens on the last stored answer and
              refreshes behind it. Which is only honest if the age is visible. */}
          {data?.cachedAt && (
            <div className="caps mb-5">
              As of {ago(data.cachedAt)}
              {isFetching ? " · refreshing…" : " · refreshes every few minutes"}
            </div>
          )}

          {data?.truncated && (
            <div className="mb-5 bg-ochre-wash border-l-2 border-ochre pl-4 pr-3 py-2.5 text-[0.8438rem] text-ochre">
              More open pull requests exist than shown. The counts are a floor.
            </div>
          )}

          {all.length === 0 ? (
            <Empty title={q ? "Nothing matches" : "Nothing open"}
              body={q ? "No open pull request matches that search."
                : "There are no open pull requests in this organization right now."} />
          ) : (
            <div className="space-y-7">
              {section({
                title: `Stale, idle ${thresholdLabel(data?.staleSeconds ?? 604_800)} or more`,
                hint: reminders
                  ? "These get one reminder naming whoever can move them. It replaces itself each cycle, and a commit resets the clock."
                  : "Reminders are off, so nothing is posted. This is the list only.",
                rows: stale, view: sv, onPage: setStalePage, total: data?.stale ?? stale.length,
              })}
              {section({
                title: "Active", rows: fresh, view: fv, onPage: setFreshPage,
                total: Math.max(0, (data?.open ?? 0) - (data?.stale ?? 0)),
              })}
            </div>
          )}
        </>
      )}
    </Page>
  );
}
