import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchRenovate, setRenovateBot, CLOSED_RETENTION_MONTHS, type RenovatePr } from "../api/renovate";
import { usePermissions } from "../hooks/usePermissions";
import { useTableControls } from "../hooks/useTableControls";
import {
  SearchInput, Pager, Segmented, Empty, Spinner, Pill, Figure, Note, SURFACE, TYPE,
} from "../design";
import {
  READINESS, READINESS_ORDER as ORDER, checkLabel, reviewLabel, type Readiness,
} from "../lib/prReadiness";

/**
 * Renovate's pull requests, and what it would take to merge each one.
 *
 * Deliberately read-only. Every row links out to GitHub, and there is no merge
 * control anywhere: merging is GitHub's job, where GitHub authorizes the
 * person doing it against the repository.
 *
 * The listing used to be a repository, a number, a title and an age, which is
 * enough to know a pull request exists and not enough to decide anything about
 * it. What somebody standing here actually wants is the subset they can merge
 * right now, so that is what the screen leads with.
 */

export default function RenovatePanel() {
  const { data: permissions } = usePermissions();
  const isAdmin = permissions?.isAwsAdmin ?? false;
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["renovate"],
    queryFn: fetchRenovate,
    staleTime: 120_000,
  });

  const [filter, setFilter] = useState<"open" | "closed" | "all">("open");
  const [only, setOnly] = useState<Readiness | null>(null);
  const [botDraft, setBotDraft] = useState("");
  // The name was settable once and then permanently fixed: the input rendered
  // only in the unconfigured branch. Renaming the bot, or a typo, left the
  // panel telling you to check the spelling with nothing to correct it with.
  const [editingBot, setEditingBot] = useState(false);
  const [saveError, setSaveError] = useState("");

  const saveBot = useMutation({
    mutationFn: (bot: string) => setRenovateBot(bot),
    onSuccess: () => { setSaveError(""); qc.invalidateQueries({ queryKey: ["renovate"] }); },
    onError: (e: any) => setSaveError(e?.message || "Could not save that."),
  });

  const rows = useMemo(() => {
    let all = data?.prs ?? [];
    if (filter !== "all") all = all.filter(p => p.state === filter);
    // The readiness filter only means anything for open ones, and applying it
    // to closed ones would empty the list for a reason nobody could see.
    if (only) all = all.filter(p => p.state === "open" && (p.readiness ?? "unknown") === only);
    return all;
  }, [data, filter, only]);

  const table = useTableControls<RenovatePr>(rows, {
    searchText: (p: RenovatePr) => `${p.repo} ${p.title} #${p.number} ${p.headRefName ?? ""}`,
    columns: [
      { key: "age", label: "Age", value: (p: RenovatePr) => -p.ageDays },
      { key: "repo", label: "Repository", value: (p: RenovatePr) => p.repo },
      { key: "updated", label: "Updated", value: (p: RenovatePr) => -new Date(p.updatedAt).getTime() },
    ],
    perPage: 25,
  });

  const botEditor = () => (
    <div className={`${SURFACE.inset} rounded-xl p-3.5`}>
      <label className={`${TYPE.label} text-slate-500 dark:text-slate-400`}>Renovate bot account</label>
      <div className="mt-2 flex gap-2 max-w-md">
        <input value={botDraft} onChange={e => setBotDraft(e.target.value)}
          placeholder="e.g. my-renovate" className={SURFACE.input} />
        <button onClick={() => saveBot.mutate(botDraft)}
          disabled={!botDraft.trim() || saveBot.isPending}
          className="shrink-0 px-4 py-2.5 text-sm font-bold rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50">
          Save
        </button>
      </div>
      {saveError && <p className="mt-2 text-[13px] text-rose-600 dark:text-rose-400">{saveError}</p>}
    </div>
  );

  if (isLoading) return <Spinner />;
  if (error) return <Note intent="danger">Could not read Renovate pull requests.</Note>;
  if (!data) return null;

  if (!data.configured) {
    return (
      <div className={`${SURFACE.card} p-6`}>
        <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>Renovate</h3>
        <p className={`${TYPE.sub} mt-1.5 text-slate-600 dark:text-slate-400 max-w-2xl leading-relaxed`}>
          Self-hosted Renovate raises pull requests as a GitHub App, and its authorship is the
          only way to find them. There is no Renovate API to ask. Type the name shown beside a
          Renovate pull request; the <code>[bot]</code> suffix an App's login carries is added for
          you if you leave it off.
        </p>
        <div className="mt-4">
          {isAdmin ? botEditor() : (
            <Note intent="warn">An organization admin has to set the bot account.</Note>
          )}
        </div>
      </div>
    );
  }

  if (data.unknownBot) {
    return (
      <div className={`${SURFACE.card} p-6`}>
        <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>Renovate</h3>
        <div className="mt-2">
          <Note intent="warn">
            GitHub does not recognize the account <code>{data.bot}</code>. It either does not
            exist, or this app cannot see it. Check the spelling of the bot account.
          </Note>
        </div>
        <div className="mt-4">
          {isAdmin ? botEditor() : (
            <p className={`${TYPE.sub} text-slate-600 dark:text-slate-400`}>
              An organization admin can correct it.
            </p>
          )}
        </div>
      </div>
    );
  }

  const all = data.prs ?? [];
  const open = all.filter(p => p.state === "open");
  const closedCount = all.length - open.length;

  // Counted over every open pull request, not the filtered page: this strip is
  // the summary somebody reads before deciding what to filter to.
  const tally = ORDER.map(state => ({
    state,
    count: open.filter(p => (p.readiness ?? "unknown") === state).length,
  })).filter(t => t.count > 0);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h3 className={`${TYPE.heading} text-slate-900 dark:text-white`}>Renovate pull requests</h3>
          <p className={`${TYPE.sub} text-slate-500 dark:text-slate-400 mt-1`}>
            Raised by <code className="px-1 rounded bg-black/5 dark:bg-white/10">{data.resolvedBot ?? data.bot}</code>
            {isAdmin && (
              <>
                {" "}
                <button onClick={() => { setBotDraft(data.bot ?? ""); setEditingBot(true); }}
                  className="font-bold text-slate-700 dark:text-slate-200 underline underline-offset-2">change</button>
              </>
            )}.
            {" "}Closed ones drop off after {CLOSED_RETENTION_MONTHS} months.
          </p>
        </div>
        <Segmented value={filter} onChange={v => { setFilter(v); setOnly(null); }} options={[
          ["open", `Open ${open.length}`],
          ["closed", `Closed ${closedCount}`],
          ["all", `All ${all.length}`],
        ]} />
      </div>

      {editingBot && botEditor()}

      {/* What is actually mergeable, before the list. The question in front of
          this screen is which ones can go now, and answering it in a row of
          counts saves opening any of them. */}
      {filter !== "closed" && tally.length > 0 && (
        <div className={`${SURFACE.card} p-4`}>
          <div className="flex flex-wrap gap-2.5">
            {tally.map(({ state, count }) => {
              const active = only === state;
              return (
                <button key={state} onClick={() => setOnly(active ? null : state)}
                  title={READINESS[state].hint}
                  className={`text-left rounded-xl px-4 py-3 border transition-all ${
                    active
                      ? "border-slate-900 dark:border-white ring-1 ring-slate-900 dark:ring-white"
                      : "border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/25"
                  }`}>
                  <Figure intent={READINESS[state].intent} value={count} label={READINESS[state].label} />
                </button>
              );
            })}
          </div>
          <p className={`${TYPE.sub} text-slate-400 dark:text-slate-500 mt-3`}>
            {only
              ? `Showing only ${READINESS[only].label.toLowerCase()}. ${READINESS[only].hint}.`
              : "Click one to filter. Nothing here merges anything: every row opens GitHub."}
          </p>
        </div>
      )}

      {data.truncated && (
        <Note intent="warn">
          GitHub stops paging search results at 1,000, so this list is partial. The counts above
          are a floor, not a total.
        </Note>
      )}

      <SearchInput value={table.search} onChange={table.setSearch}
        placeholder="Search repository, title or branch…" />

      {table.visible.length === 0 ? (
        <Empty title={filter === "open" ? "Nothing waiting" : "Nothing here"}
          body={only
            ? `No open pull requests are ${READINESS[only].label.toLowerCase()}.`
            : filter === "open"
              ? "Renovate has no open pull requests. Everything it raised has been dealt with."
              : "No pull requests match."} />
      ) : (
        <div className="grid gap-2">
          {table.visible.map(pr => {
            const state = (pr.readiness ?? "unknown") as Readiness;
            const r = READINESS[state];
            const checks = checkLabel(pr.checks);
            const review = reviewLabel(pr.reviewDecision);
            const size = pr.changedFiles !== undefined;

            return (
              // The whole row is the link out. This app never merges.
              <a key={pr.id} href={pr.url} target="_blank" rel="noopener noreferrer"
                className={`block ${SURFACE.card} ${SURFACE.cardHover} px-4 py-3.5`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-slate-900 dark:text-slate-100">{pr.repo}</span>
                      <span className="text-[12px] text-slate-400 dark:text-slate-500 tabular-nums">#{pr.number}</span>
                      {pr.state === "open" && pr.draft && <Pill intent="neutral">draft</Pill>}
                      {pr.state === "open" && !pr.draft && <Pill intent={r.intent}>{r.label}</Pill>}
                      {pr.state === "closed" && pr.merged && <Pill intent="good">merged</Pill>}
                      {pr.state === "closed" && !pr.merged && <Pill intent="neutral">closed</Pill>}
                    </div>

                    <p className={`${TYPE.sub} mt-1 text-slate-700 dark:text-slate-300`}>{pr.title}</p>

                    {/* The detail line. Each part is withheld rather than
                        guessed at when it did not come back, so a blank space
                        here means "not established", never "fine". */}
                    <div className="mt-1.5 flex items-center gap-x-3 gap-y-1 flex-wrap text-[12px] text-slate-500 dark:text-slate-400">
                      {checks && (
                        <span className={
                          pr.checks === "SUCCESS" ? "text-emerald-700 dark:text-emerald-400 font-semibold"
                            : pr.checks === "FAILURE" || pr.checks === "ERROR" ? "text-rose-700 dark:text-rose-400 font-semibold"
                            : ""
                        }>{checks}</span>
                      )}
                      {review && <span>{review}</span>}
                      {pr.mergeable === "CONFLICTING" && (
                        <span className="text-amber-700 dark:text-amber-400 font-semibold">conflicts</span>
                      )}
                      {size && (
                        <span className="tabular-nums">
                          <span className="text-emerald-700 dark:text-emerald-400">+{pr.additions ?? 0}</span>
                          {" "}
                          <span className="text-rose-700 dark:text-rose-400">−{pr.deletions ?? 0}</span>
                          {" "}across {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
                        </span>
                      )}
                      {pr.headRefName && (
                        <span className="font-mono text-[11.5px] text-slate-400 dark:text-slate-500">
                          {pr.headRefName}
                        </span>
                      )}
                      {(pr.labels ?? []).slice(0, 3).map(l => (
                        <span key={l} className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-white/[0.07] text-[11px]">
                          {l}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-[12px] text-slate-500 dark:text-slate-400">
                    {pr.state === "open"
                      ? <>open {pr.ageDays} day{pr.ageDays === 1 ? "" : "s"}</>
                      : <>closed {new Date(pr.closedAt ?? "").toLocaleDateString()}</>}
                    <div className="mt-0.5 font-bold text-slate-700 dark:text-slate-200">open on GitHub →</div>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}

      <Pager page={table.page} totalPages={table.totalPages} onPage={table.setPage}
        matchCount={table.matchCount} totalCount={table.totalCount}
        filtered={table.filtered} noun="pull requests" />
    </div>
  );
}
