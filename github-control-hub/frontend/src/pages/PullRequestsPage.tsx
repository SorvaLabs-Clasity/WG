import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../App";
import { apiGet, apiPut, apiPost } from "../api/client";
import { usePermissions } from "../hooks/usePermissions";
import { Page, Empty, Spinner, Pager, SearchInput } from "../design";
import UserAvatar from "../components/UserAvatar";

type BlockReason =
  | "ready" | "needs-approval" | "changes-requested"
  | "draft" | "conflict" | "behind" | "checks-failing" | "checks-pending" | "blocked";

interface Pull {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headRef: string;
  baseRef: string;
  idleDays: number;
  stale: boolean;
  blockReason: BlockReason;
  requestedReviewers: string[];
  pendingReviewers: string[];
  wouldNudge: string[];
  paused: boolean;
  pausedLogins: string[];
  lastNudgedAt: string | null;
  nudgeCount: number;
}

interface Answer {
  staleSeconds: number;
  truncated: boolean;
  open: number;
  stale: number;
  pulls: Pull[];
}

/** What each state means, and who it puts on the hook. */
const BLOCK: Record<BlockReason, { label: string; chip: string }> = {
  "ready": { label: "Ready to merge", chip: "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300" },
  "needs-approval": { label: "Waiting on review", chip: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300" },
  "changes-requested": { label: "Changes requested", chip: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300" },
  "draft": { label: "Draft", chip: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
  "conflict": { label: "Conflicts", chip: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300" },
  "behind": { label: "Behind base", chip: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300" },
  "checks-pending": { label: "Checks running", chip: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
  "checks-failing": { label: "Checks failing", chip: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300" },
  "blocked": { label: "Blocked", chip: "bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300" },
};

export default function PullRequestsPage() {
  const { user } = useAuth();
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [stalePage, setStalePage] = useState(1);
  const [freshPage, setFreshPage] = useState(1);

  // Polled rather than cached for two minutes. A pull request opened a moment
  // ago should appear without restarting the app, which is what a two-minute
  // staleTime and no refetch interval produced.
  const { data, isLoading, isFetching, error: loadError, refetch } = useQuery<Answer>({
    queryKey: ["pulls"],
    queryFn: () => apiGet<Answer>("/pulls"),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const runNow = useMutation({
    mutationFn: () => apiPost<{ due: number; posted: number; skippedPaused: number; failed: number }>(
      "/pulls/run", {}),
    onSuccess: (r) => {
      setError("");
      setNotice(r.posted
        ? `Sent ${r.posted} reminder${r.posted === 1 ? "" : "s"}.`
        : r.due === 0
          ? "Nothing was due."
          : `${r.due} due, none sent — everyone who would be named is paused.`);
      qc.invalidateQueries({ queryKey: ["pulls"] });
    },
    onError: (e: any) => setError(e?.message || "Could not send reminders."),
  });

  const pause = useMutation({
    mutationFn: (body: { repo: string; number: number; paused?: boolean; pausedLogins?: string[] }) =>
      apiPut<unknown>("/pulls/pause", body),
    onSuccess: () => { setError(""); qc.invalidateQueries({ queryKey: ["pulls"] }); },
    onError: (e: any) => setError(e?.message || "Could not change that."),
  });

  if (isLoading) return <Page user={user}><Spinner /></Page>;
  if (loadError) {
    return <Page user={user}>
      <Empty title="Could not read pull requests" body={(loadError as Error).message} />
    </Page>;
  }

  const PER_PAGE = 25;

  // Searched before splitting, so a term matches across both sections rather
  // than only the one being looked at.
  const q = search.trim().toLowerCase();
  const pulls = (data?.pulls ?? []).filter(p => !q
    || `${p.repo}#${p.number} ${p.title} ${p.author} ${p.headRef} ${p.baseRef}`.toLowerCase().includes(q));
  const stale = pulls.filter(p => p.stale);
  const fresh = pulls.filter(p => !p.stale);

  // Clamped rather than trusted. Filtering can shrink a list under the page
  // being viewed, which would otherwise show an empty section and read as
  // "nothing here" when there is plenty on page one.
  const pageOf = (rows: Pull[], page: number) => {
    const totalPages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    const safe = Math.min(Math.max(1, page), totalPages);
    return { totalPages, safe, slice: rows.slice((safe - 1) * PER_PAGE, safe * PER_PAGE) };
  };
  const staleView = pageOf(stale, stalePage);
  const freshView = pageOf(fresh, freshPage);

  const humanThreshold = (() => {
    const secs = data?.staleSeconds ?? 604_800;
    if (secs >= 86_400) return `${Math.round(secs / 86_400)} day${secs >= 172_800 ? "s" : ""}`;
    if (secs >= 3_600) return `${Math.round(secs / 3_600)} hour${secs >= 7_200 ? "s" : ""}`;
    if (secs >= 60) return `${Math.round(secs / 60)} minute${secs >= 120 ? "s" : ""}`;
    return `${secs} second${secs === 1 ? "" : "s"}`;
  })();

  const Row = ({ p }: { p: Pull }) => {
    const block = BLOCK[p.blockReason] ?? BLOCK.blocked;
    return (
      <li className="rounded-xl bg-white dark:bg-slate-900 border border-gh-border dark:border-slate-700 p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <a href={p.url} target="_blank" rel="noopener noreferrer"
              className="font-semibold text-gh-textBase dark:text-slate-200 hover:text-gh-blue">
              {p.title}
            </a>
            <div className="mt-1 flex items-center gap-2 flex-wrap text-xs text-gray-500 dark:text-slate-400">
              <UserAvatar login={p.author} size={18} />
              <span>{p.author}</span>
              <span>·</span>
              <code className="px-1 rounded bg-black/5 dark:bg-white/10">{p.repo}#{p.number}</code>
              <span>·</span>
              {/* The direction matters and is easy to get backwards, so it is
                  spelled out rather than shown as two bare names. */}
              <span>
                <code className="px-1 rounded bg-black/5 dark:bg-white/10">{p.headRef}</code>
                {" → "}
                <code className="px-1 rounded bg-black/5 dark:bg-white/10">{p.baseRef}</code>
              </span>
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <span className={`text-[11px] font-bold uppercase tracking-wide px-2 py-1 rounded-md ${block.chip}`}>
              {block.label}
            </span>
            <span className="text-sm font-black tabular-nums text-gh-textBase dark:text-slate-200"
              title="Days since the last commit — the clock reminders run on">
              {p.idleDays}d
            </span>
          </div>
        </div>

        {p.stale && (
          <div className="mt-3 pt-3 border-t border-gh-border dark:border-slate-700 flex items-start justify-between gap-4 flex-wrap">
            <div className="text-xs text-gray-600 dark:text-slate-400">
              {p.paused ? (
                <span className="text-slate-500 dark:text-slate-400">
                  <i className="ph ph-pause-circle mr-1"></i>Reminders paused for this pull request
                </span>
              ) : p.wouldNudge.length === 0 ? (
                // The state that would otherwise look like the feature failing.
                <span className="text-slate-500 dark:text-slate-400">
                  Nobody left to remind — everyone who would be named is paused
                </span>
              ) : (
                <>Next reminder names {p.wouldNudge.map(l => <code key={l}
                  className="mx-0.5 px-1 rounded bg-black/5 dark:bg-white/10">@{l}</code>)}</>
              )}
              {p.nudgeCount > 0 && (
                <span className="ml-2 text-slate-400 dark:text-slate-500">
                  · {p.nudgeCount} sent so far
                </span>
              )}
            </div>

            {isAdmin && (
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => pause.mutate({ repo: p.repo, number: p.number, paused: !p.paused })}
                  className="text-xs font-semibold text-gh-blue hover:underline">
                  {p.paused ? "Resume reminders" : "Pause reminders"}
                </button>
                {/* Per-person pausing, for the reviewer who has said they will
                    not be reviewing this one. Only offered for people who would
                    actually be named, since pausing anyone else does nothing. */}
                {!p.paused && p.wouldNudge.map(l => (
                  <button key={l}
                    onClick={() => pause.mutate({
                      repo: p.repo, number: p.number,
                      pausedLogins: [...p.pausedLogins, l],
                    })}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-gh-blue hover:underline">
                    mute @{l}
                  </button>
                ))}
                {p.pausedLogins.length > 0 && (
                  <button
                    onClick={() => pause.mutate({ repo: p.repo, number: p.number, pausedLogins: [] })}
                    className="text-xs text-slate-500 dark:text-slate-400 hover:text-gh-blue hover:underline">
                    unmute {p.pausedLogins.length}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <Page user={user}>
      <header className="mb-6">
        <h1 className="text-2xl font-black tracking-tight text-slate-900 dark:text-white">Open pull requests</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 max-w-3xl">
          Every open pull request in the organization, most idle first. Closed ones never appear.
          "Idle" counts time since the last <strong>commit</strong>, not since it was opened — a
          months-old branch pushed to this morning is alive, and a week-old one nobody has touched
          is not. The list refreshes on its own every 30 seconds.
        </p>
      </header>

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-[240px]">
          <SearchInput value={search} onChange={(v: string) => { setSearch(v); setStalePage(1); setFreshPage(1); }}
            placeholder="Search title, repository, author or branch…" />
        </div>
        <button onClick={() => refetch()} disabled={isFetching}
          className="px-3 py-2 text-sm font-semibold rounded-md text-gh-textBase dark:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40">
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
        {isAdmin && (
          <button onClick={() => runNow.mutate()} disabled={runNow.isPending}
            title="Run the reminder pass now instead of waiting for the next scheduled one"
            className="px-4 py-2 text-sm font-semibold rounded-md bg-gh-blue text-white hover:opacity-90 disabled:opacity-40">
            {runNow.isPending ? "Sending…" : "Send reminders now"}
          </button>
        )}
      </div>

      {/* Shown only when the threshold is not the real one. A test override left
          on by accident would otherwise remind everyone every few minutes with
          nothing on screen explaining why. */}
      {(data?.staleSeconds ?? 604_800) < 86_400 && (
        <div className="mb-4 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          <strong>Test threshold active.</strong> Pull requests are treated as stale after{" "}
          {humanThreshold} instead of 7 days, and reminded again on the same interval.
          <code className="mx-1 px-1 rounded bg-black/10 dark:bg-white/10">STALE_SECONDS</code>
          in <code className="px-1 rounded bg-black/10 dark:bg-white/10">prNudgeService.ts</code>
          controls this; set it back to <code className="px-1 rounded bg-black/10 dark:bg-white/10">SEVEN_DAYS</code> and redeploy.
        </div>
      )}

      {notice && (
        <div className="mb-4 rounded-md bg-green-50 dark:bg-green-950/40 px-4 py-3 text-sm text-green-800 dark:text-green-300">
          {notice}
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {data?.truncated && (
        <div className="mb-4 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          More open pull requests exist than this list shows. The counts below are a floor.
        </div>
      )}

      {pulls.length === 0 ? (
        <Empty title="Nothing open"
          body="There are no open pull requests in this organization right now." />
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-1">
              Stale — no commit for {humanThreshold}+
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">{stale.length}</span>
            </h2>
            <p className="text-xs text-gray-500 dark:text-slate-400 mb-3">
              These get a reminder on the pull request naming whoever is holding them up. It
              replaces itself each cycle rather than adding a comment, and a commit resets the clock.
            </p>
            {stale.length === 0
              ? <p className="text-sm text-gray-500 dark:text-slate-400">Nothing has gone quiet.</p>
              : <>
                  <ul className="grid gap-2">
                    {staleView.slice.map(p => <Row key={`${p.repo}#${p.number}`} p={p} />)}
                  </ul>
                  {staleView.totalPages > 1 && (
                    <div className="mt-3">
                      <Pager page={staleView.safe} totalPages={staleView.totalPages}
                        onPage={setStalePage} matchCount={stale.length}
                        totalCount={data?.stale ?? stale.length} filtered={!!q}
                        noun="stale pull requests" />
                    </div>
                  )}
                </>}
          </section>

          <section>
            <h2 className="text-base font-bold text-gray-900 dark:text-white mb-3">
              Active
              <span className="ml-2 text-sm font-normal text-gray-500 dark:text-slate-400">{fresh.length}</span>
            </h2>
            {fresh.length === 0
              ? <p className="text-sm text-gray-500 dark:text-slate-400">Everything open has gone quiet.</p>
              : <>
                  <ul className="grid gap-2">
                    {freshView.slice.map(p => <Row key={`${p.repo}#${p.number}`} p={p} />)}
                  </ul>
                  {freshView.totalPages > 1 && (
                    <div className="mt-3">
                      <Pager page={freshView.safe} totalPages={freshView.totalPages}
                        onPage={setFreshPage} matchCount={fresh.length}
                        totalCount={(data?.open ?? 0) - (data?.stale ?? 0)} filtered={!!q}
                        noun="pull requests" />
                    </div>
                  )}
                </>}
          </section>
        </div>
      )}
    </Page>
  );
}
